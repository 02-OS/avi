import React, { useCallback, useEffect, useRef, useState } from 'react'
import { getProjects, type Project } from '../../lib/projectService'
import { useModalFocusTrap } from '../../hooks/useModalFocusTrap'
import { toast } from '../../lib/toastStore'

interface ProjectSwitcherModalProps {
  isOpen: boolean
  isSignedIn: boolean
  currentProjectId: string | null
  onClose: () => void
  onOpenAuth: () => void
  onSelectProject: (projectId: string) => Promise<void>
  onCreateProject: (name: string) => Promise<void>
  onRenameProject: (projectId: string, name: string) => Promise<void>
  onDeleteProject: (projectId: string) => Promise<void>
}

export const ProjectSwitcherModal: React.FC<ProjectSwitcherModalProps> = ({
  isOpen,
  isSignedIn,
  currentProjectId,
  onClose,
  onOpenAuth,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
}) => {
  const modalRef = useRef<HTMLDivElement>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useModalFocusTrap(isOpen, modalRef, onClose)

  const refreshProjects = useCallback(async () => {
    if (!isSignedIn) return
    setLoading(true)
    try {
      const list = await getProjects()
      setProjects(list)
    } catch (error) {
      console.error('Failed to list projects:', error)
      toast.error('Failed to load cloud projects')
    } finally {
      setLoading(false)
    }
  }, [isSignedIn])

  useEffect(() => {
    if (!isOpen) return
    setEditingId(null)
    setConfirmDeleteId(null)
    if (isSignedIn) {
      void refreshProjects()
    }
  }, [isOpen, isSignedIn, refreshProjects])

  useEffect(() => {
    if (!confirmDeleteId) return
    const timer = window.setTimeout(() => setConfirmDeleteId(null), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmDeleteId])

  if (!isOpen) return null

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isSignedIn) return
    setBusyId('__create__')
    try {
      await onCreateProject(newName.trim() || 'Untitled Project')
      setNewName('')
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create project')
    } finally {
      setBusyId(null)
    }
  }

  const handleRenameSubmit = async (id: string) => {
    const trimmed = editingName.trim()
    if (!trimmed) return
    setBusyId(id)
    try {
      await onRenameProject(id, trimmed)
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)))
      setEditingId(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to rename project')
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      return
    }
    setBusyId(id)
    try {
      await onDeleteProject(id)
      setProjects((prev) => prev.filter((p) => p.id !== id))
      setConfirmDeleteId(null)
      if (id === currentProjectId) {
        await refreshProjects()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete project')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(4px)',
          zIndex: 40,
        }}
      />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-switcher-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(520px, calc(100vw - 32px))',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#1a1a1a',
          border: '1px solid #2e2e2e',
          borderRadius: 12,
          padding: 20,
          zIndex: 50,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 id="project-switcher-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#fff' }}>
            Projects
          </h3>
          <button
            onClick={onClose}
            aria-label="Close projects dialog"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: '#777',
              fontSize: 16,
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ✕
          </button>
        </div>

        {!isSignedIn ? (
          <div style={{ padding: '16px 12px', textAlign: 'center', color: '#aaa', fontSize: 13, lineHeight: 1.6 }}>
            <p style={{ marginBottom: 14 }}>
              You are editing locally in this workspace. Sign in to create, switch, and sync multiple cloud projects.
            </p>
            <button
              onClick={() => {
                onClose()
                onOpenAuth()
              }}
              style={{
                background: '#e94560',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                padding: '10px 18px',
                cursor: 'pointer',
              }}
            >
              Sign In to Sync Projects
            </button>
          </div>
        ) : (
          <>
            <form onSubmit={handleCreate} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New project name..."
                aria-label="New project name"
                style={{
                  flex: 1,
                  background: '#242424',
                  border: '1px solid #333',
                  borderRadius: 6,
                  color: '#fff',
                  fontSize: 13,
                  padding: '8px 12px',
                }}
              />
              <button
                type="submit"
                disabled={busyId !== null}
                style={{
                  background: '#e94560',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '8px 14px',
                  cursor: busyId !== null ? 'not-allowed' : 'pointer',
                }}
              >
                + New Project
              </button>
            </form>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {loading ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#777', fontSize: 13 }}>
                  Loading projects...
                </div>
              ) : projects.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#777', fontSize: 13 }}>
                  No cloud projects yet.
                </div>
              ) : (
                projects.map((project) => {
                  const isCurrent = project.id === currentProjectId
                  const isEditing = editingId === project.id

                  return (
                    <div
                      key={project.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: isCurrent ? 'rgba(233,69,96,0.1)' : '#222',
                        border: isCurrent ? '1px solid rgba(233,69,96,0.45)' : '1px solid #2e2e2e',
                      }}
                    >
                      {isEditing ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault()
                            void handleRenameSubmit(project.id)
                          }}
                          style={{ flex: 1, display: 'flex', gap: 6 }}
                        >
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            aria-label="Project name"
                            autoFocus
                            style={{
                              flex: 1,
                              background: '#161616',
                              border: '1px solid #444',
                              borderRadius: 4,
                              color: '#fff',
                              fontSize: 13,
                              padding: '4px 8px',
                            }}
                          />
                          <button
                            type="submit"
                            style={{
                              background: '#059669',
                              border: 'none',
                              borderRadius: 4,
                              color: '#fff',
                              fontSize: 11,
                              padding: '4px 8px',
                              cursor: 'pointer',
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            style={{
                              background: '#333',
                              border: 'none',
                              borderRadius: 4,
                              color: '#bbb',
                              fontSize: 11,
                              padding: '4px 8px',
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {project.name}
                              {isCurrent && (
                                <span style={{ marginLeft: 8, fontSize: 10, color: '#e94560', fontWeight: 700 }}>
                                  CURRENT
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>
                              {project.total_frames} frames · {project.fps} fps
                            </div>
                          </div>

                          {!isCurrent && (
                            <button
                              onClick={() => {
                                setBusyId(project.id)
                                void onSelectProject(project.id)
                                  .then(() => onClose())
                                  .catch((err) => toast.error(err instanceof Error ? err.message : 'Failed to open project'))
                                  .finally(() => setBusyId(null))
                              }}
                              disabled={busyId !== null}
                              style={{
                                background: '#1a6cf0',
                                border: 'none',
                                borderRadius: 5,
                                color: '#fff',
                                fontSize: 11,
                                fontWeight: 600,
                                padding: '5px 10px',
                                cursor: 'pointer',
                              }}
                            >
                              Open
                            </button>
                          )}

                          <button
                            onClick={() => {
                              setEditingId(project.id)
                              setEditingName(project.name)
                            }}
                            aria-label={`Rename ${project.name}`}
                            title="Rename project"
                            style={{
                              background: '#2a2a2a',
                              border: '1px solid #3a3a3a',
                              borderRadius: 5,
                              color: '#ccc',
                              fontSize: 11,
                              padding: '5px 8px',
                              cursor: 'pointer',
                            }}
                          >
                            Rename
                          </button>

                          <button
                            onClick={() => void handleDelete(project.id)}
                            disabled={busyId !== null}
                            aria-label={confirmDeleteId === project.id ? `Confirm delete ${project.name}` : `Delete ${project.name}`}
                            title={confirmDeleteId === project.id ? 'Click again to confirm delete' : 'Delete project'}
                            style={{
                              background: confirmDeleteId === project.id ? 'rgba(233,69,96,0.2)' : '#2a2a2a',
                              border: `1px solid ${confirmDeleteId === project.id ? '#e94560' : '#3a3a3a'}`,
                              borderRadius: 5,
                              color: confirmDeleteId === project.id ? '#e94560' : '#888',
                              fontSize: 11,
                              padding: '5px 8px',
                              cursor: 'pointer',
                            }}
                          >
                            {confirmDeleteId === project.id ? 'Confirm' : 'Delete'}
                          </button>
                        </>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}
