//! Loopback server for local media.
//!
//! WebKitGTK reports media error 4 for `asset://` URLs in a `<video>` element.
//! This server reads only files the editor has allowed, binds to 127.0.0.1,
//! requires a per-launch random token, restricts CORS to app origins,
//! and answers HTTP range requests so playback can seek.

use std::collections::hash_map::RandomState;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs::File;
use std::hash::BuildHasher;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MEDIA_WORKERS: usize = 8;
const MEDIA_QUEUE_CAP: usize = 64;
const MAX_HEADER_BYTES: usize = 8192;

const ALLOWED_ORIGINS: &[&str] = &[
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

#[derive(Clone)]
pub struct MediaServer {
    port: u16,
    token: String,
    allowed: Arc<Mutex<HashSet<PathBuf>>>,
}

impl MediaServer {
    pub fn start() -> std::io::Result<Self> {
        let allowed = Arc::new(Mutex::new(HashSet::new()));
        let token = generate_session_token();
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();

        let (tx, rx) = mpsc::sync_channel::<TcpStream>(MEDIA_QUEUE_CAP);
        let rx = Arc::new(Mutex::new(rx));

        for worker_id in 0..MEDIA_WORKERS {
            let worker_rx = Arc::clone(&rx);
            let worker_allowed = Arc::clone(&allowed);
            let worker_token = token.clone();
            thread::Builder::new()
                .name(format!("avi-media-worker-{worker_id}"))
                .spawn(move || loop {
                    let stream = {
                        let Ok(guard) = worker_rx.lock() else {
                            break;
                        };
                        guard.recv()
                    };
                    match stream {
                        Ok(stream) => {
                            let _ = handle_connection(stream, &worker_allowed, &worker_token);
                        }
                        Err(_) => break,
                    }
                })?;
        }

        thread::Builder::new()
            .name("avi-media-accept".into())
            .spawn(move || accept_loop(listener, tx))?;

        Ok(Self {
            port,
            token,
            allowed,
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn allow(&self, path: &Path) -> Result<(), String> {
        let canonical = canonicalize_file(path)?;
        let mut allowed = self
            .allowed
            .lock()
            .map_err(|_| "media allow list is locked".to_string())?;
        allowed.insert(canonical);
        Ok(())
    }

    pub fn disallow(&self, path: &Path) {
        if let Ok(mut allowed) = self.allowed.lock() {
            if let Ok(canonical) = path.canonicalize() {
                allowed.remove(&canonical);
            }
            allowed.remove(path);
        }
    }
}

fn generate_session_token() -> String {
    let mut bytes = [0u8; 16];
    #[cfg(unix)]
    let filled = File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_ok();
    #[cfg(not(unix))]
    let filled = false;

    if !filled {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let h1 = RandomState::new().hash_one((now, std::process::id(), 1u64));
        let h2 = RandomState::new().hash_one((now.wrapping_add(1), std::process::id(), 2u64));
        bytes[..8].copy_from_slice(&h1.to_le_bytes());
        bytes[8..].copy_from_slice(&h2.to_le_bytes());
    }

    let mut hex = String::with_capacity(32);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&left, &right) in a.iter().zip(b.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn canonicalize_file(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("media path is empty".into());
    }
    let text = path.to_str().ok_or("media path is not valid unicode")?;
    if text.contains('\0') {
        return Err("media path is not valid".into());
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.is_file() {
        return Err("media path is not a file".into());
    }
    Ok(canonical)
}

fn accept_loop(listener: TcpListener, tx: mpsc::SyncSender<TcpStream>) {
    for connection in listener.incoming() {
        let Ok(stream) = connection else {
            continue;
        };
        if let Err(mpsc::TrySendError::Full(mut full_stream)) = tx.try_send(stream) {
            let _ = write_empty(&mut full_stream, "503 Service Unavailable", None);
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    allowed: &Mutex<HashSet<PathBuf>>,
    expected_token: &str,
) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
    let _ = stream.set_nodelay(true);

    let header_text = match read_headers(&stream) {
        Ok(text) => text,
        Err(_) => return write_empty(&mut stream, "400 Bad Request", None),
    };
    let mut lines = header_text.split("\r\n");
    let Some(request_line) = lines.next() else {
        return write_empty(&mut stream, "400 Bad Request", None);
    };
    let mut parts = request_line.split_whitespace();
    let Some(method) = parts.next() else {
        return write_empty(&mut stream, "400 Bad Request", None);
    };
    let Some(target) = parts.next() else {
        return write_empty(&mut stream, "400 Bad Request", None);
    };

    let mut origin_header: Option<String> = None;
    let mut range_header: Option<String> = None;
    let mut header_token: Option<String> = None;

    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let trimmed_value = value.trim();
        if name.eq_ignore_ascii_case("origin") {
            origin_header = Some(trimmed_value.to_string());
        } else if name.eq_ignore_ascii_case("range") {
            range_header = Some(trimmed_value.to_string());
        } else if name.eq_ignore_ascii_case("x-media-token") {
            header_token = Some(trimmed_value.to_string());
        } else if name.eq_ignore_ascii_case("authorization") && header_token.is_none() {
            if let Some(bearer) = trimmed_value
                .strip_prefix("Bearer ")
                .or_else(|| trimmed_value.strip_prefix("bearer "))
            {
                header_token = Some(bearer.trim().to_string());
            }
        }
    }

    let cors_origin = match origin_header {
        Some(origin) => {
            if ALLOWED_ORIGINS.contains(&origin.as_str()) {
                Some(origin)
            } else {
                return write_empty(&mut stream, "403 Forbidden", None);
            }
        }
        None => None,
    };

    if method == "OPTIONS" {
        return write_no_content(&mut stream, cors_origin.as_deref());
    }
    if method != "GET" && method != "HEAD" {
        return write_empty(&mut stream, "405 Method Not Allowed", cors_origin.as_deref());
    }

    let Some(query) = parse_media_query(target) else {
        return write_empty(&mut stream, "400 Bad Request", cors_origin.as_deref());
    };
    let provided_token = query.token.or(header_token);
    let Some(provided_token) = provided_token else {
        return write_empty(&mut stream, "401 Unauthorized", cors_origin.as_deref());
    };
    if !constant_time_eq(provided_token.as_bytes(), expected_token.as_bytes()) {
        return write_empty(&mut stream, "401 Unauthorized", cors_origin.as_deref());
    }

    let raw_path = query.path;
    if raw_path.len() > 4096 || raw_path.contains('\0') {
        return write_empty(&mut stream, "400 Bad Request", cors_origin.as_deref());
    }

    let candidate = PathBuf::from(&raw_path);
    let canonical = match canonicalize_file(&candidate) {
        Ok(path) => path,
        Err(_) => return write_empty(&mut stream, "404 Not Found", cors_origin.as_deref()),
    };
    let allowed_path = allowed
        .lock()
        .map(|set| set.contains(&canonical))
        .unwrap_or(false);
    if !allowed_path {
        return write_empty(&mut stream, "403 Forbidden", cors_origin.as_deref());
    }

    let mut file = File::open(&canonical)?;
    let length = file.metadata()?.len();

    let (status, start, end_inclusive) = if let Some(header) = range_header {
        match parse_byte_range(&header, length) {
            Some(range) => ("206 Partial Content", range.start, range.end_inclusive),
            None => return write_range_not_satisfiable(&mut stream, length, cors_origin.as_deref()),
        }
    } else if length == 0 {
        ("200 OK", 0, 0)
    } else {
        ("200 OK", 0, length - 1)
    };

    let body_len = if length == 0 {
        0
    } else {
        end_inclusive - start + 1
    };
    let content_type = content_type(&canonical);
    let cors = cors_headers(cors_origin.as_deref());
    let head = if status.starts_with("206") {
        format!(
            "HTTP/1.1 206 Partial Content\r\n\
             Content-Type: {content_type}\r\n\
             Accept-Ranges: bytes\r\n\
             Content-Range: bytes {start}-{end_inclusive}/{length}\r\n\
             Content-Length: {body_len}\r\n\
             {cors}\
             Connection: close\r\n\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 {status}\r\n\
             Content-Type: {content_type}\r\n\
             Accept-Ranges: bytes\r\n\
             Content-Length: {body_len}\r\n\
             {cors}\
             Connection: close\r\n\r\n"
        )
    };
    stream.write_all(head.as_bytes())?;
    if method == "HEAD" || body_len == 0 {
        return Ok(());
    }

    file.seek(SeekFrom::Start(start))?;
    let mut remaining = body_len;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let chunk = remaining.min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..chunk])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn cors_headers(origin: Option<&str>) -> String {
    let allow_origin = origin
        .map(|value| format!("Access-Control-Allow-Origin: {value}\r\n"))
        .unwrap_or_default();
    format!(
        "{allow_origin}\
         Vary: Origin\r\n\
         Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: Range, Authorization, X-Media-Token\r\n\
         Access-Control-Expose-Headers: Accept-Ranges, Content-Range, Content-Length, Content-Type\r\n"
    )
}

fn write_no_content(stream: &mut TcpStream, origin: Option<&str>) -> std::io::Result<()> {
    let cors = cors_headers(origin);
    let head = format!(
        "HTTP/1.1 204 No Content\r\n\
         {cors}\
         Connection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())
}

fn write_empty(stream: &mut TcpStream, status: &str, origin: Option<&str>) -> std::io::Result<()> {
    if status.starts_with("204") {
        return write_no_content(stream, origin);
    }
    let body = status.as_bytes();
    let cors = cors_headers(origin);
    let head = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         {cors}\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

fn write_range_not_satisfiable(
    stream: &mut TcpStream,
    length: u64,
    origin: Option<&str>,
) -> std::io::Result<()> {
    let cors = cors_headers(origin);
    let head = format!(
        "HTTP/1.1 416 Range Not Satisfiable\r\n\
         Content-Range: bytes */{length}\r\n\
         Content-Length: 0\r\n\
         {cors}\
         Connection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())
}

fn read_headers(stream: &TcpStream) -> std::io::Result<String> {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::with_capacity(1024);
    loop {
        let mut line = Vec::new();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if buffer.len() + line.len() > MAX_HEADER_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "media request headers exceeded size limit",
            ));
        }
        let is_end = line == b"\r\n" || line == b"\n";
        buffer.extend_from_slice(&line);
        if is_end {
            break;
        }
    }
    if !buffer.ends_with(b"\r\n\r\n") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "media request headers were incomplete",
        ));
    }
    String::from_utf8(buffer)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

struct MediaQuery {
    path: String,
    token: Option<String>,
}

fn parse_media_query(target: &str) -> Option<MediaQuery> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/media" {
        return None;
    }
    let mut media_path: Option<String> = None;
    let mut token: Option<String> = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == "path" {
            media_path = Some(percent_decode(value).ok()?);
        } else if key == "token" {
            token = Some(percent_decode(value).ok()?);
        }
    }
    Some(MediaQuery {
        path: media_path?,
        token,
    })
}

fn percent_decode(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = from_hex(bytes[index + 1]).ok_or(())?;
            let low = from_hex(bytes[index + 2]).ok_or(())?;
            decoded.push((high << 4) | low);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

struct ByteRange {
    start: u64,
    end_inclusive: u64,
}

fn parse_byte_range(header: &str, length: u64) -> Option<ByteRange> {
    if length == 0 {
        return None;
    }
    let trimmed = header.trim();
    if trimmed.len() < 6 || !trimmed[..6].eq_ignore_ascii_case("bytes=") {
        return None;
    }
    let spec = trimmed[6..].split(',').next()?.trim();
    if let Some(suffix) = spec.strip_prefix('-') {
        let count: u64 = suffix.parse().ok()?;
        if count == 0 {
            return None;
        }
        let count = count.min(length);
        return Some(ByteRange {
            start: length - count,
            end_inclusive: length - 1,
        });
    }
    let (start_text, end_text) = spec.split_once('-')?;
    let start: u64 = start_text.parse().ok()?;
    if start >= length {
        return None;
    }
    let end_inclusive = if end_text.is_empty() {
        length - 1
    } else {
        end_text.parse::<u64>().ok()?.min(length - 1)
    };
    if end_inclusive < start {
        return None;
    }
    Some(ByteRange {
        start,
        end_inclusive,
    })
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn decodes_an_encoded_absolute_path() {
        let decoded = percent_decode("%2Fhome%2Fcsy20%2Fclip.mp4").unwrap();
        assert_eq!(decoded, "/home/csy20/clip.mp4");
    }

    #[test]
    fn parses_open_suffix_and_case_insensitive_ranges() {
        let open = parse_byte_range("bytes=4-", 16).unwrap();
        assert_eq!((open.start, open.end_inclusive), (4, 15));
        let suffix = parse_byte_range("BYTES=-4", 16).unwrap();
        assert_eq!((suffix.start, suffix.end_inclusive), (12, 15));
        let mixed = parse_byte_range("Bytes=2-5", 16).unwrap();
        assert_eq!((mixed.start, mixed.end_inclusive), (2, 5));
        assert!(parse_byte_range("bytes=20-30", 16).is_none());
    }

    #[test]
    fn tolerates_valueless_query_parameters() {
        let parsed = parse_media_query("/media?flag&path=%2Ftmp%2Fclip.mp4&token=abc").unwrap();
        assert_eq!(parsed.path, "/tmp/clip.mp4");
        assert_eq!(parsed.token.as_deref(), Some("abc"));
    }

    #[test]
    fn serves_allowed_file_with_token_cors_and_rfc9110_204() {
        let directory = std::env::temp_dir().join(format!("avi-media-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let media = directory.join("clip.mp4");
        let other = directory.join("other.mp4");
        std::fs::write(&media, b"0123456789abcdef").unwrap();
        std::fs::write(&other, b"nope").unwrap();

        let server = MediaServer::start().unwrap();
        server.allow(&media).unwrap();

        let unauthorized = http_request(
            &server,
            "GET",
            &media_url(&media, None),
            None,
            None,
        );
        assert!(
            unauthorized.starts_with("HTTP/1.1 401 Unauthorized"),
            "{unauthorized}"
        );

        let bad_origin = http_request(
            &server,
            "GET",
            &media_url(&media, Some(server.token())),
            None,
            Some("https://evil.example"),
        );
        assert!(bad_origin.starts_with("HTTP/1.1 403 Forbidden"), "{bad_origin}");
        assert!(!bad_origin.contains("Access-Control-Allow-Origin: *"));

        let allowed = http_request(
            &server,
            "GET",
            &media_url(&media, Some(server.token())),
            Some("BYTES=4-7"),
            Some("tauri://localhost"),
        );
        assert!(allowed.starts_with("HTTP/1.1 206 Partial Content"), "{allowed}");
        assert!(allowed.contains("Content-Type: video/mp4"));
        assert!(allowed.contains("Content-Range: bytes 4-7/16"));
        assert!(allowed.contains("Access-Control-Allow-Origin: tauri://localhost"));
        assert!(allowed.ends_with("4567"), "{allowed}");

        let full = http_request(
            &server,
            "GET",
            &media_url(&media, Some(server.token())),
            None,
            Some("http://127.0.0.1:1420"),
        );
        assert!(full.starts_with("HTTP/1.1 200 OK"), "{full}");
        assert!(full.ends_with("0123456789abcdef"), "{full}");

        let preflight = http_request(
            &server,
            "OPTIONS",
            &media_url(&media, None),
            None,
            Some("http://127.0.0.1:1420"),
        );
        assert!(preflight.starts_with("HTTP/1.1 204 No Content"), "{preflight}");
        assert!(!preflight.contains("Content-Length:"));
        assert!(preflight.ends_with("\r\n\r\n"), "{preflight:?}");

        let forbidden = http_request(
            &server,
            "GET",
            &media_url(&other, Some(server.token())),
            None,
            None,
        );
        assert!(forbidden.starts_with("HTTP/1.1 403 Forbidden"), "{forbidden}");

        let _ = std::fs::remove_dir_all(&directory);
    }

    fn media_url(path: &Path, token: Option<&str>) -> String {
        let mut encoded = String::new();
        for byte in path.to_str().unwrap().bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        match token {
            Some(tok) => format!("/media?flag&path={encoded}&token={tok}"),
            None => format!("/media?path={encoded}"),
        }
    }

    fn http_request(
        server: &MediaServer,
        method: &str,
        target: &str,
        range: Option<&str>,
        origin: Option<&str>,
    ) -> String {
        let mut stream = TcpStream::connect(format!("127.0.0.1:{}", server.port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let range_header = range
            .map(|value| format!("Range: {value}\r\n"))
            .unwrap_or_default();
        let origin_header = origin
            .map(|value| format!("Origin: {value}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n{origin_header}{range_header}Connection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }
}
