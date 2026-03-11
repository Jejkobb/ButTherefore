import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ConnectionLineType,
  Controls,
  SelectionMode,
  type FinalConnectionState,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type OnConnectStartParams,
  type NodeDragHandler,
  type Viewport,
  type XYPosition
} from "@xyflow/react";
import { ChevronDown, Clock3, FilePlus, FolderOpen, HardDriveDownload, ImagePlus, Locate, Moon, Plus, Redo2, RefreshCw, Save, SaveAll, StickyNote, Sun, Undo2 } from "lucide-react";
import appIcon from "../../icons/icon.png";
import { ImageNode } from "@/renderer/components/ImageNode";
import { PostItNode } from "@/renderer/components/PostItNode";
import { StoryEdge } from "@/renderer/components/StoryEdge";
import { StoryNode } from "@/renderer/components/StoryNode";
import { useGraphStore } from "@/renderer/store/useGraphStore";
import type { RecentProjectEntry, StartupData, UpdateState } from "@/shared/ipc";

const nodeTypes = { storyNode: StoryNode, postItNode: PostItNode, imageNode: ImageNode };
const edgeTypes = { storyEdge: StoryEdge };
const THEME_STORAGE_KEY = "buttherefore:theme";

type ThemeMode = "dark" | "light";

function readInitialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
}

function eventToClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("touches" in event && event.touches.length > 0) {
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }

  if ("changedTouches" in event && event.changedTouches.length > 0) {
    return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
  }

  return { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
}

function isSameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

type MenuId = "file" | "edit" | "insert";

interface CreateOption {
  id: "node" | "postit" | "image";
  title: string;
  description: string;
  action: () => void | Promise<unknown>;
  icon: typeof Plus;
}

interface StartupScreenProps {
  data: StartupData | null;
  loading: boolean;
  busy: boolean;
  checkingForUpdates: boolean;
  error: string | null;
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenRecent: (projectPath: string) => void;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
}

function formatRecentProjectTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function describeUpdate(update: UpdateState | null): string {
  if (!update) return "Update status unavailable.";

  switch (update.status) {
    case "unsupported":
      return update.message ?? "Updates are available in packaged builds only.";
    case "idle":
      return "Check for updates to verify if a new version is available.";
    case "checking":
      return "Checking for updates...";
    case "available":
      return update.message ?? "A new update is available and downloading.";
    case "not-available":
      return update.message ?? "You are using the latest version.";
    case "downloaded":
      return update.message ?? "An update is ready to install.";
    case "error":
      return update.message ?? "Update check failed.";
    default:
      return "Update status unavailable.";
  }
}

function StartupScreen({
  data,
  loading,
  busy,
  checkingForUpdates,
  error,
  onNewProject,
  onOpenProject,
  onOpenRecent,
  onCheckUpdates,
  onInstallUpdate
}: StartupScreenProps) {
  const appName = data?.appName ?? "ButTherefore";
  const version = data?.version ?? "0.0.0";
  const recentProjects = data?.recentProjects ?? [];
  const update = data?.update ?? null;
  const canInstallUpdate = update?.status === "downloaded";
  const canCheckUpdates =
    !checkingForUpdates &&
    !busy &&
    update !== null &&
    update.status !== "unsupported" &&
    update.status !== "checking" &&
    update.status !== "available";

  return (
    <div className="startup-shell" role="dialog" aria-modal="true" aria-label={`${appName} startup`}>
      <div className="startup-surface">
        <section className="startup-hero">
          <div className="startup-hero__brand">
            <img className="startup-hero__logo" src={appIcon} alt={`${appName} logo`} />
            <div className="startup-hero__title-wrap">
              <p className="startup-hero__kicker">Story Workspace</p>
              <h1 className="startup-hero__title">{appName}</h1>
              <p className="startup-hero__version">Version {version}</p>
            </div>
          </div>

          <div className="startup-hero__actions">
            <button className="startup-btn startup-btn--primary" type="button" onClick={onNewProject} disabled={busy}>
              New Project
            </button>
            <button className="startup-btn" type="button" onClick={onOpenProject} disabled={busy}>
              Open Project
            </button>
          </div>
        </section>

        <section className="startup-content">
          <article className="startup-card startup-card--recent">
            <header className="startup-card__header">
              <h2>Recent Projects</h2>
              <span>{recentProjects.length}</span>
            </header>

            <div className="startup-recent-list">
              {loading ? <div className="startup-empty">Loading recent projects...</div> : null}
              {!loading && recentProjects.length === 0 ? <div className="startup-empty">No recent projects yet.</div> : null}
              {!loading
                ? recentProjects.map((entry) => (
                    <button
                      key={entry.path}
                      className="startup-recent-item"
                      type="button"
                      onClick={() => onOpenRecent(entry.path)}
                      disabled={busy}
                    >
                      <strong>{entry.name}</strong>
                      <span>{entry.path}</span>
                      <small>
                        <Clock3 size={10} aria-hidden="true" />
                        <span>{formatRecentProjectTime(entry.lastOpenedAt)}</span>
                      </small>
                    </button>
                  ))
                : null}
            </div>
          </article>

          <article className="startup-card startup-card--update">
            <header className="startup-card__header">
              <h2>Software Update</h2>
              <HardDriveDownload size={15} aria-hidden="true" />
            </header>
            <p className="startup-update__status">{describeUpdate(update)}</p>
            {update?.latestVersion ? <p className="startup-update__version">Latest: v{update.latestVersion}</p> : null}
            <button
              className="startup-btn startup-btn--update"
              type="button"
              disabled={canInstallUpdate ? busy : !canCheckUpdates}
              onClick={canInstallUpdate ? onInstallUpdate : onCheckUpdates}
            >
              {canInstallUpdate ? "Restart and Install" : checkingForUpdates ? "Checking..." : "Check for Updates"}
              {!canInstallUpdate ? <RefreshCw size={14} aria-hidden="true" /> : null}
            </button>
          </article>

          {error ? <div className="startup-error">{error}</div> : null}
        </section>
      </div>
    </div>
  );
}

function Editor() {
  const flow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const projectNameInputRef = useRef<HTMLInputElement | null>(null);
  const dragStartPositions = useRef<Record<string, XYPosition>>({});
  const connectStartRef = useRef<OnConnectStartParams | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [showCreatePalette, setShowCreatePalette] = useState(false);
  const [createQuery, setCreateQuery] = useState("");
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProjectEntry[]>([]);
  const [isLoadingRecentProjects, setIsLoadingRecentProjects] = useState(false);

  const doc = useGraphStore((state) => state.doc);
  const history = useGraphStore((state) => state.history);
  const projectName = useGraphStore((state) => state.projectName);
  const dirty = useGraphStore((state) => state.dirty);

  const applyNodeChangesLive = useGraphStore((state) => state.applyNodeChangesLive);
  const applyEdgeChangesLive = useGraphStore((state) => state.applyEdgeChangesLive);
  const setViewport = useGraphStore((state) => state.setViewport);
  const connectNodes = useGraphStore((state) => state.connectNodes);
  const createNodeFromConnection = useGraphStore((state) => state.createNodeFromConnection);
  const commitNodeMove = useGraphStore((state) => state.commitNodeMove);
  const createNode = useGraphStore((state) => state.createNode);
  const createPostItNode = useGraphStore((state) => state.createPostItNode);
  const createImageNodes = useGraphStore((state) => state.createImageNodes);
  const deleteSelection = useGraphStore((state) => state.deleteSelection);
  const undo = useGraphStore((state) => state.undo);
  const redo = useGraphStore((state) => state.redo);
  const newProject = useGraphStore((state) => state.newProject);
  const openProject = useGraphStore((state) => state.openProject);
  const openProjectAtPath = useGraphStore((state) => state.openProjectAtPath);
  const saveProject = useGraphStore((state) => state.saveProject);
  const saveProjectAs = useGraphStore((state) => state.saveProjectAs);
  const autosaveProject = useGraphStore((state) => state.autosaveProject);
  const updateProjectName = useGraphStore((state) => state.updateProjectName);

  const backgroundDotColor = theme === "dark" ? "rgba(255, 255, 255, 0.14)" : "rgba(21, 31, 45, 0.2)";
  const miniMapNodeColor = theme === "dark" ? "rgba(210, 210, 210, 0.7)" : "rgba(68, 82, 102, 0.58)";
  const miniMapMaskColor = theme === "dark" ? "rgba(5, 5, 5, 0.76)" : "rgba(241, 244, 248, 0.72)";
  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const closeCreatePalette = useCallback(() => {
    setShowCreatePalette(false);
    setCreateQuery("");
  }, []);

  const openCreatePalette = useCallback(() => {
    setOpenMenu(null);
    setCreateQuery("");
    setShowCreatePalette(true);
  }, []);

  const runMenuAction = useCallback((action: () => void | Promise<unknown>) => {
    setOpenMenu(null);
    setShowCreatePalette(false);
    setCreateQuery("");
    void action();
  }, []);

  const loadRecentProjects = useCallback(async () => {
    setIsLoadingRecentProjects(true);
    try {
      const startup = await window.storyBridge.getStartupData();
      setRecentProjects(startup.recentProjects);
    } catch (error) {
      console.error("Failed to load recent projects", error);
      setRecentProjects([]);
    } finally {
      setIsLoadingRecentProjects(false);
    }
  }, []);

  const createNodeAtViewportCenter = useCallback(() => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const center = flow.screenToFlowPosition({
      x: (bounds?.left ?? 0) + (bounds?.width ?? window.innerWidth) / 2,
      y: (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2
    });
    createNode(center);
  }, [createNode, flow]);

  const createPostItAtViewportCenter = useCallback(() => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const center = flow.screenToFlowPosition({
      x: (bounds?.left ?? 0) + (bounds?.width ?? window.innerWidth) / 2,
      y: (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2
    });
    createPostItNode(center);
  }, [createPostItNode, flow]);

  const createImageAtViewportCenter = useCallback(async () => {
    const filePaths = await window.storyBridge.pickImageFiles();
    if (filePaths.length === 0) return;

    const bounds = wrapperRef.current?.getBoundingClientRect();
    const center = flow.screenToFlowPosition({
      x: (bounds?.left ?? 0) + (bounds?.width ?? window.innerWidth) / 2,
      y: (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2
    });
    await createImageNodes(center, filePaths);
  }, [createImageNodes, flow]);

  const createOptions = useMemo<CreateOption[]>(
    () => [
      {
        id: "node",
        title: "Node",
        description: "Story beat node with beats, images, and connections",
        action: createNodeAtViewportCenter,
        icon: Plus
      },
      {
        id: "postit",
        title: "Note",
        description: "Standalone lined note that does not connect",
        action: createPostItAtViewportCenter,
        icon: StickyNote
      },
      {
        id: "image",
        title: "Image",
        description: "Standalone image frame that can dock into story nodes",
        action: createImageAtViewportCenter,
        icon: ImagePlus
      }
    ],
    [createImageAtViewportCenter, createNodeAtViewportCenter, createPostItAtViewportCenter]
  );

  const filteredCreateOptions = useMemo(() => {
    const query = createQuery.trim().toLowerCase();
    if (!query) return createOptions;
    return createOptions.filter(
      (option) =>
        option.title.toLowerCase().includes(query) ||
        option.description.toLowerCase().includes(query)
    );
  }, [createOptions, createQuery]);

  const primaryCreateOption = filteredCreateOptions[0] ?? null;

  const frameAllNodes = useCallback(() => {
    if (useGraphStore.getState().doc.nodes.length === 0) return;
    void flow.fitView({
      padding: 0.22,
      duration: 180,
      includeHiddenNodes: true
    });
  }, [flow]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (dirty) {
        void autosaveProject();
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [dirty, doc, autosaveProject]);

  const onNodeDragStart: NodeDragHandler = useCallback((_event, node) => {
    const currentNodes = useGraphStore.getState().doc.nodes;
    const draggedNodes = currentNodes.filter((candidate) => candidate.selected || candidate.id === node.id);

    dragStartPositions.current = draggedNodes.reduce<Record<string, XYPosition>>((acc, candidate) => {
      acc[candidate.id] = { ...candidate.position };
      return acc;
    }, {});
  }, []);

  const onNodeDragStop: NodeDragHandler = useCallback(() => {
    commitNodeMove(dragStartPositions.current);
    dragStartPositions.current = {};
  }, [commitNodeMove]);

  useEffect(() => {
    // Browser/electron can occasionally miss drag-stop if pointer-up occurs outside the window.
    const forceStopDrag = () => {
      if (Object.keys(dragStartPositions.current).length === 0) return;
      commitNodeMove(dragStartPositions.current);
      dragStartPositions.current = {};
    };

    window.addEventListener("pointerup", forceStopDrag);
    window.addEventListener("pointercancel", forceStopDrag);
    window.addEventListener("mouseup", forceStopDrag);
    window.addEventListener("touchend", forceStopDrag);
    window.addEventListener("blur", forceStopDrag);

    return () => {
      window.removeEventListener("pointerup", forceStopDrag);
      window.removeEventListener("pointercancel", forceStopDrag);
      window.removeEventListener("mouseup", forceStopDrag);
      window.removeEventListener("touchend", forceStopDrag);
      window.removeEventListener("blur", forceStopDrag);
    };
  }, [commitNodeMove]);

  useEffect(() => {
    const currentViewport = flow.getViewport();
    if (isSameViewport(currentViewport, doc.viewport)) return;
    void flow.setViewport(doc.viewport, { duration: 0 });
  }, [doc.viewport, flow]);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      const connectStart = connectStartRef.current;
      connectStartRef.current = null;

      if (!connectStart || connectStart.handleType !== "source" || !connectStart.nodeId || connectionState.isValid) {
        return;
      }

      const flowPosition = flow.screenToFlowPosition(eventToClientPosition(event));

      createNodeFromConnection(connectStart.nodeId, connectStart.handleId, flowPosition);
    },
    [createNodeFromConnection, flow]
  );

  useEffect(() => {
    // Global shortcuts: N, Delete, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+S, Ctrl/Cmd+O.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (showCreatePalette) {
          closeCreatePalette();
          return;
        }
        setOpenMenu(null);
        return;
      }

      const targetTyping = isTypingTarget(event.target);
      const modKey = event.metaKey || event.ctrlKey;

      if (modKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
        return;
      }

      if (modKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openProject();
        return;
      }

      if (modKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if (targetTyping) return;

      if (!modKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        openCreatePalette();
        return;
      }

      if (!modKey && event.key === "Home") {
        event.preventDefault();
        frameAllNodes();
        return;
      }

      if (!modKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        createNodeAtViewportCenter();
        return;
      }

      if (!modKey && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeCreatePalette, createNodeAtViewportCenter, deleteSelection, frameAllNodes, openCreatePalette, openProject, redo, saveProject, setOpenMenu, showCreatePalette, undo]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!showCreatePalette) return;
    const frame = requestAnimationFrame(() => {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [showCreatePalette]);

  useEffect(() => {
    setProjectNameDraft(projectName);
  }, [projectName]);

  const commitProjectName = useCallback(() => {
    const normalized = projectNameDraft.trim();
    updateProjectName(normalized.length > 0 ? normalized : "Untitled Project");
    setIsEditingProjectName(false);
  }, [projectNameDraft, updateProjectName]);

  const cancelProjectNameEdit = useCallback(() => {
    setProjectNameDraft(projectName);
    setIsEditingProjectName(false);
  }, [projectName]);

  useEffect(() => {
    if (!isEditingProjectName) return;
    const frame = requestAnimationFrame(() => {
      projectNameInputRef.current?.focus();
      projectNameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [isEditingProjectName]);

  return (
    <div className="app-shell">
      <header className="app-toolbar">
        <div className="app-toolbar__brand">ButTherefore</div>
        {openMenu ? (
          <button className="app-menu-backdrop" type="button" aria-label="Close menu" onClick={() => setOpenMenu(null)} />
        ) : null}
        <div className="app-toolbar__actions">
          <div className={`app-menu ${openMenu === "file" ? "is-open" : ""}`}>
            <button
              className="app-menu__trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "file"}
              onClick={() =>
                setOpenMenu((current) => {
                  const next = current === "file" ? null : "file";
                  if (next === "file") {
                    void loadRecentProjects();
                  }
                  return next;
                })
              }
            >
              <span>File</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {openMenu === "file" ? (
              <div className="app-menu__panel" role="menu">
                <button onClick={() => runMenuAction(newProject)} type="button">
                  <FilePlus size={14} aria-hidden="true" />
                  <span>New</span>
                </button>
                <button onClick={() => runMenuAction(openProject)} type="button">
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>Open</span>
                </button>
                <div className="app-menu__section-title">Open Recent</div>
                {isLoadingRecentProjects ? (
                  <button type="button" disabled>
                    <FolderOpen size={14} aria-hidden="true" />
                    <span>Loading...</span>
                  </button>
                ) : null}
                {!isLoadingRecentProjects && recentProjects.length === 0 ? (
                  <button type="button" disabled>
                    <FolderOpen size={14} aria-hidden="true" />
                    <span>No recent projects</span>
                  </button>
                ) : null}
                {!isLoadingRecentProjects
                  ? recentProjects.slice(0, 6).map((entry) => (
                      <button key={entry.path} onClick={() => runMenuAction(() => openProjectAtPath(entry.path))} type="button">
                        <FolderOpen size={14} aria-hidden="true" />
                        <span>{entry.name}</span>
                      </button>
                    ))
                  : null}
                <button onClick={() => runMenuAction(saveProject)} type="button">
                  <Save size={14} aria-hidden="true" />
                  <span>Save</span>
                </button>
                <button onClick={() => runMenuAction(saveProjectAs)} type="button">
                  <SaveAll size={14} aria-hidden="true" />
                  <span>Save As</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className={`app-menu ${openMenu === "edit" ? "is-open" : ""}`}>
            <button
              className="app-menu__trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "edit"}
              onClick={() => setOpenMenu((current) => (current === "edit" ? null : "edit"))}
            >
              <span>Edit</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {openMenu === "edit" ? (
              <div className="app-menu__panel" role="menu">
                <button onClick={() => runMenuAction(undo)} type="button" disabled={history.past.length === 0}>
                  <Undo2 size={14} aria-hidden="true" />
                  <span>Undo</span>
                </button>
                <button onClick={() => runMenuAction(redo)} type="button" disabled={history.future.length === 0}>
                  <Redo2 size={14} aria-hidden="true" />
                  <span>Redo</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className={`app-menu ${openMenu === "insert" ? "is-open" : ""}`}>
            <button
              className="app-menu__trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === "insert"}
              onClick={() => setOpenMenu((current) => (current === "insert" ? null : "insert"))}
            >
              <span>Insert</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {openMenu === "insert" ? (
              <div className="app-menu__panel" role="menu">
                <button onClick={() => runMenuAction(createNodeAtViewportCenter)} type="button">
                  <Plus size={14} aria-hidden="true" />
                  <span>Node</span>
                </button>
                <button onClick={() => runMenuAction(createPostItAtViewportCenter)} type="button">
                  <StickyNote size={14} aria-hidden="true" />
                  <span>Note</span>
                </button>
                <button onClick={() => runMenuAction(createImageAtViewportCenter)} type="button">
                  <ImagePlus size={14} aria-hidden="true" />
                  <span>Image</span>
                </button>
                <button onClick={() => runMenuAction(frameAllNodes)} type="button">
                  <Locate size={14} aria-hidden="true" />
                  <span>Frame All</span>
                </button>
                <button onClick={() => runMenuAction(openCreatePalette)} type="button">
                  <StickyNote size={14} aria-hidden="true" />
                  <span>Quick Create (Shift+A)</span>
                </button>
              </div>
            ) : null}
          </div>

          <button
            className="app-theme-toggle"
            onClick={toggleTheme}
            type="button"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
        <div className="app-toolbar__project">
          {isEditingProjectName ? (
            <input
              ref={projectNameInputRef}
              id="project-name-input"
              className="app-toolbar__project-name"
              type="text"
              value={projectNameDraft}
              onChange={(event) => setProjectNameDraft(event.target.value)}
              onBlur={commitProjectName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitProjectName();
                  event.currentTarget.blur();
                  return;
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelProjectNameEdit();
                }
              }}
              aria-label="Project name"
              placeholder="Untitled Project"
              maxLength={80}
            />
          ) : (
            <div
              className="app-toolbar__project-display"
              role="button"
              tabIndex={0}
              onDoubleClick={() => setIsEditingProjectName(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setIsEditingProjectName(true);
                }
              }}
              title="Double-click to rename"
            >
              {projectName}
              {dirty ? " *" : ""}
            </div>
          )}
        </div>
      </header>

      {showCreatePalette ? (
        <div className="create-palette" role="dialog" aria-modal="true" aria-label="Create">
          <button className="create-palette__backdrop" type="button" aria-label="Close create menu" onClick={closeCreatePalette} />
          <form
            className="create-palette__panel"
            onSubmit={(event) => {
              event.preventDefault();
              if (primaryCreateOption) {
                runMenuAction(primaryCreateOption.action);
              }
            }}
          >
            <input
              ref={createInputRef}
              className="create-palette__input"
              value={createQuery}
              onChange={(event) => setCreateQuery(event.target.value)}
              placeholder="Search creatables..."
            />
            <div className="create-palette__list">
              {filteredCreateOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.id}
                    className="create-palette__item"
                    type="button"
                    onClick={() => runMenuAction(option.action)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{option.title}</span>
                    <small>{option.description}</small>
                  </button>
                );
              })}
              {filteredCreateOptions.length === 0 ? (
                <div className="create-palette__empty">No matches</div>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}

      <main className="canvas-shell" ref={wrapperRef}>
        <ReactFlow
          proOptions={{ hideAttribution: true }}
          nodes={doc.nodes}
          edges={doc.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={applyNodeChangesLive}
          onEdgesChange={applyEdgeChangesLive}
          onConnect={connectNodes}
          onConnectStart={(_event, params) => {
            connectStartRef.current = params;
          }}
          onConnectEnd={onConnectEnd}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.Bezier}
          panOnDrag={[1]}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          deleteKeyCode={null}
          snapToGrid={false}
          minZoom={0.25}
          maxZoom={2.2}
          onlyRenderVisibleElements
          fitView={false}
          defaultViewport={doc.viewport}
          onMoveEnd={(_event, nextViewport) => {
            setViewport(nextViewport);
          }}
          onPaneDoubleClick={(event) => {
            const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            createNode(position);
          }}
          defaultEdgeOptions={{
            type: "storyEdge",
            animated: false
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={30} size={1.15} color={backgroundDotColor} />
          <Controls className="flow-controls" showInteractive={false} />
          <MiniMap
            className="flow-minimap"
            pannable
            zoomable
            nodeColor={() => miniMapNodeColor}
            maskColor={miniMapMaskColor}
          />
        </ReactFlow>
      </main>
    </div>
  );
}

export default function App() {
  const newProject = useGraphStore((state) => state.newProject);
  const openProject = useGraphStore((state) => state.openProject);
  const openProjectAtPath = useGraphStore((state) => state.openProjectAtPath);
  const launchPathAttemptRef = useRef<string | null>(null);
  const [showStartup, setShowStartup] = useState(true);
  const [startupData, setStartupData] = useState<StartupData | null>(null);
  const [startupLoading, setStartupLoading] = useState(true);
  const [startupBusy, setStartupBusy] = useState(false);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);

  const loadStartupData = useCallback(async () => {
    try {
      const next = await window.storyBridge.getStartupData();
      setStartupData(next);
      setStartupError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load startup data.";
      setStartupError(message);
    } finally {
      setStartupLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStartupData();
  }, [loadStartupData]);

  useEffect(() => {
    if (!showStartup) return;
    const status = startupData?.update.status;
    if (status !== "checking" && status !== "available") return;

    const timer = window.setInterval(() => {
      void loadStartupData();
    }, 2600);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadStartupData, showStartup, startupData?.update.status]);

  const withStartupBusy = useCallback(
    async (action: () => Promise<void>) => {
      if (startupBusy) return;
      setStartupBusy(true);
      setStartupError(null);
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Action failed.";
        setStartupError(message);
      } finally {
        setStartupBusy(false);
      }
    },
    [startupBusy]
  );

  useEffect(() => {
    if (!showStartup) return;
    const launchProjectPath = startupData?.launchProjectPath;
    if (!launchProjectPath || launchPathAttemptRef.current === launchProjectPath) return;

    launchPathAttemptRef.current = launchProjectPath;

    void withStartupBusy(async () => {
      const opened = await openProjectAtPath(launchProjectPath);
      if (opened) {
        setShowStartup(false);
        return;
      }

      setStartupError(`Could not open ${launchProjectPath}.`);
      await loadStartupData();
    });
  }, [loadStartupData, openProjectAtPath, showStartup, startupData?.launchProjectPath, withStartupBusy]);

  const handleNewProject = useCallback(() => {
    void withStartupBusy(async () => {
      await newProject();
      setShowStartup(false);
    });
  }, [newProject, withStartupBusy]);

  const handleOpenProject = useCallback(() => {
    void withStartupBusy(async () => {
      const opened = await openProject();
      if (opened) {
        setShowStartup(false);
      } else {
        await loadStartupData();
      }
    });
  }, [loadStartupData, openProject, withStartupBusy]);

  const handleOpenRecent = useCallback(
    (projectPath: string) => {
      void withStartupBusy(async () => {
        const opened = await openProjectAtPath(projectPath);
        if (opened) {
          setShowStartup(false);
          return;
        }

        setStartupError("Could not open that project.");
        await loadStartupData();
      });
    },
    [loadStartupData, openProjectAtPath, withStartupBusy]
  );

  const handleCheckForUpdates = useCallback(() => {
    if (checkingForUpdates || startupBusy) return;

    setCheckingForUpdates(true);
    setStartupError(null);

    void window.storyBridge
      .checkForUpdates()
      .then((update) => {
        setStartupData((current) => {
          if (!current) return current;
          return {
            ...current,
            update
          };
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Failed to check for updates.";
        setStartupError(message);
      })
      .finally(() => {
        setCheckingForUpdates(false);
        void loadStartupData();
      });
  }, [checkingForUpdates, loadStartupData, startupBusy]);

  const handleInstallUpdate = useCallback(() => {
    if (startupBusy) return;

    void withStartupBusy(async () => {
      const started = await window.storyBridge.installUpdate();
      if (!started) {
        const update = await window.storyBridge.checkForUpdates();
        setStartupData((current) => (current ? { ...current, update } : current));
      }
    });
  }, [startupBusy, withStartupBusy]);

  return (
    <ReactFlowProvider>
      <Editor />
      {showStartup ? (
        <StartupScreen
          data={startupData}
          loading={startupLoading}
          busy={startupBusy}
          checkingForUpdates={checkingForUpdates}
          error={startupError}
          onNewProject={handleNewProject}
          onOpenProject={handleOpenProject}
          onOpenRecent={handleOpenRecent}
          onCheckUpdates={handleCheckForUpdates}
          onInstallUpdate={handleInstallUpdate}
        />
      ) : null}
    </ReactFlowProvider>
  );
}
