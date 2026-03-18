import {
  ButtonItem,
  ConfirmModal,
  DialogBody,
  DropdownItem,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ProgressBarWithInfo,
  showModal,
  TextField,
  staticClasses,
} from "@decky/ui";
import {
  addEventListener,
  removeEventListener,
  callable,
  definePlugin,
  toaster,
} from "@decky/api";
import { useState, useEffect, useCallback, useMemo } from "react";
import { FaYoutube } from "react-icons/fa";

// ---------------------------------------------------------------------------
// Backend callables
// ---------------------------------------------------------------------------
const getVideoFiles = callable<[], VideoFile[]>("get_video_files");
const getGameNames = callable<[], Record<string, string>>("get_game_names");
const getSettings = callable<[], PluginSettings>("get_settings");
const saveSettings = callable<[settings: PluginSettings], CallResult>("save_settings");
const convertToMp4 = callable<[source_path: string, game_id: string, output_name: string, quality: string], CallResult>(
  "convert_to_mp4"
);
const convertSteamClip = callable<[clip_folder: string, game_id: string, output_name: string, quality: string], CallResult>(
  "convert_steam_clip"
);
const deleteSteamClip = callable<[clip_folder: string], CallResult>("delete_steam_clip");
const deleteVideo = callable<[filepath: string], CallResult>("delete_video");
const saveCredentials = callable<[client_id: string, client_secret: string], CallResult>(
  "save_credentials"
);
const getCredentials = callable<[], Credentials>("get_credentials");
const startAuth = callable<[client_id: string, client_secret: string], AuthStartResult>(
  "start_auth"
);
const pollAuth = callable<[], AuthPollResult>("poll_auth");
const checkAuth = callable<[], AuthStatus>("check_auth");
const revokeAuth = callable<[], CallResult>("revoke_auth");
const uploadToYoutube = callable<
  [
    filepath: string,
    title: string,
    description: string,
    tags: string,
    privacy: string,
  ],
  CallResult
>("upload_to_youtube");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface VideoFile {
  path: string;
  name: string;
  size: number;
  modified: number;
  ext: string;
  needs_conversion: boolean;
  is_steam_clip: boolean;
  game_id?: string;
  clip_type?: string;
}

interface PluginSettings {
  use_game_subfolders: boolean;
}

interface CallResult {
  success: boolean;
  error?: string;
  started?: boolean;
}

interface Credentials {
  client_id?: string;
  client_secret?: string;
}

interface AuthStartResult {
  success: boolean;
  user_code?: string;
  verification_url?: string;
  error?: string;
}

interface AuthPollResult {
  success: boolean;
  authenticated?: boolean;
  pending?: boolean;
  error?: string;
}

interface AuthStatus {
  authenticated: boolean;
  needs_reauth?: boolean;
  error?: string;
}

interface UploadProgress {
  progress?: number;
  status: "starting" | "uploading" | "complete" | "error";
  video_id?: string;
  video_url?: string;
  error?: string;
}

interface ConversionProgress {
  status: "started" | "converting" | "complete" | "error";
  progress?: number;
  output_path?: string;
  size?: number;
  error?: string;
}

type View = "list" | "clips" | "videos" | "settings";

const QUALITY_OPTIONS = [
  { value: "copy", label: "Original", description: "Fast — no re-encoding" },
  { value: "high", label: "Smaller file", description: "Re-encode, ~40% smaller" },
  { value: "medium", label: "Smallest file", description: "Re-encode, ~60% smaller" },
] as const;

// ---------------------------------------------------------------------------
// UploadModal — full-screen modal for YouTube upload form.
//
// Opens over everything (including the QAM panel) so the on-screen keyboard
// doesn't overlap any fields.  The upload itself runs in the background after
// the modal closes — progress / completion is reported via toast notifications.
// ---------------------------------------------------------------------------
function UploadModal({
  closeModal,
  video,
  authenticated,
}: {
  closeModal: () => void;
  video: VideoFile;
  authenticated: boolean;
}) {
  const [title, setTitle] = useState(video.name.replace(/\.[^/.]+$/, ""));
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [privacy, setPrivacy] = useState<"private" | "unlisted" | "public">("private");

  const privacyOptions = [
    { data: "private" as const, label: "Private" },
    { data: "unlisted" as const, label: "Unlisted" },
    { data: "public" as const, label: "Public" },
  ];

  return (
    <ConfirmModal
      strTitle="Upload to YouTube"
      strOKButtonText={authenticated ? "Upload" : "YouTube not connected"}
      bOKDisabled={!authenticated}
      strCancelButtonText="Cancel"
      onOK={() => {
        uploadToYoutube(
          video.path,
          title || video.name,
          description,
          tags,
          privacy
        ).then((result) => {
          if (result.success) {
            toaster.toast({ title: "Upload Started", body: `Uploading "${title || video.name}"...` });
          } else {
            toaster.toast({ title: "Upload Error", body: result.error ?? "Failed to start upload" });
          }
        });
      }}
      onCancel={closeModal}
      closeModal={closeModal}
    >
      <DialogBody>
        <div style={{ fontSize: "12px", color: "#aaa", marginBottom: "12px" }}>
          {video.name} ({formatSize(video.size)})
        </div>
        <TextField
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextField
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextField
          label="Tags (comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <DropdownItem
          label="Privacy"
          rgOptions={privacyOptions}
          selectedOption={privacy}
          onChange={(opt) => setPrivacy(opt.data)}
        />
      </DialogBody>
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// ExportModal — full-screen modal for naming a clip before MP4 export.
// ---------------------------------------------------------------------------
function ExportModal({
  closeModal,
  clip,
  gameName: gName,
}: {
  closeModal: () => void;
  clip: VideoFile;
  gameName: string;
}) {
  const defaultName = `${gName} - ${clip.clip_type === "video" ? "Recording" : "Clip"} ${formatDateTime(clip.modified)}`;
  const [name, setName] = useState(defaultName);
  const [quality, setQuality] = useState("copy");

  return (
    <ConfirmModal
      strTitle="Export to MP4"
      strOKButtonText="Export"
      strCancelButtonText="Cancel"
      onOK={() => {
        convertSteamClip(clip.path, clip.game_id ?? "", name, quality).then((result) => {
          if (result.success) {
            toaster.toast({ title: "Export Started", body: `Exporting "${name}"...` });
          } else {
            toaster.toast({ title: "Export Error", body: result.error ?? "Failed to start export" });
          }
        });
      }}
      onCancel={closeModal}
      closeModal={closeModal}
    >
      <DialogBody>
        <div style={{ fontSize: "12px", color: "#aaa", marginBottom: "12px" }}>
          {gName} · {clip.clip_type === "video" ? "Background Recording" : "Manual Clip"}
          <br />
          {formatSize(clip.size)} · {formatDate(clip.modified)}
        </div>
        <TextField
          label="Export Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <DropdownItem
          label="Quality"
          description="Original quality is set in Steam > Settings > Game Recording"
          rgOptions={QUALITY_OPTIONS.map((opt) => ({
            data: opt.value,
            label: `${opt.label} — ${opt.description}`,
          }))}
          selectedOption={quality}
          onChange={(opt) => setQuality(opt.data)}
        />
      </DialogBody>
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString();
}

function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// InlineSelect — a non-modal dropdown that stays inside the panel.
//
// Steam's built-in DropdownItem always opens a full-screen native modal and
// closes the panel when an option is selected — that is by design in the
// Steam QAM UI and cannot be overridden via any prop.  InlineSelect renders
// an inline option list using plain ButtonItems so no navigation occurs.
// ---------------------------------------------------------------------------
interface SelectOption<T extends string> {
  value: T;
  label: string;
}

function InlineSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Focusable>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => setOpen((o) => !o)}
        >
          {label}: {selected?.label ?? value} {open ? "▲" : "▼"}
        </ButtonItem>
      </PanelSectionRow>
      {open &&
        options.map((opt) => (
          <PanelSectionRow key={opt.value}>
            <div
              style={
                opt.value === value
                  ? { background: "rgba(255,255,255,0.12)", borderRadius: "4px" }
                  : undefined
              }
            >
              <ButtonItem
                layout="below"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.value === value ? "✓  " : "    "}
                {opt.label}
              </ButtonItem>
            </div>
          </PanelSectionRow>
        ))}
    </Focusable>
  );
}

// ---------------------------------------------------------------------------
// Content component
// ---------------------------------------------------------------------------
function Content() {
  const [view, setView] = useState<View>("list");
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [gameNames, setGameNames] = useState<Record<string, string>>({});
  const [pluginSettings, setPluginSettings] = useState<PluginSettings>({
    use_game_subfolders: true,
  });
  const [loading, setLoading] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Auth state
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [useCustomCredentials, setUseCustomCredentials] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [authPolling, setAuthPolling] = useState(false);

  // Conversion state
  const [converting, setConverting] = useState(false);
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);

  // Clip filters
  const [clipGameFilter, setClipGameFilter] = useState("all");
  const [clipTypeFilter, setClipTypeFilter] = useState<"all" | "clips" | "video">("all");

  // Exported video filters
  const [videoGameFilter, setVideoGameFilter] = useState("all");

  // Sort
  const [clipSort, setClipSort] = useState<"date" | "size">("date");
  const [videoSort, setVideoSort] = useState<"date" | "size">("date");

  // ── Derived data ──────────────────────────────────────────────────────────
  const steamClips = useMemo(() => videos.filter((v) => v.is_steam_clip), [videos]);
  const exportedVideos = useMemo(() => videos.filter((v) => !v.is_steam_clip), [videos]);

  const uniqueClipGameIds = useMemo(
    () =>
      ["all", ...Array.from(new Set(steamClips.map((c) => c.game_id ?? "unknown"))).sort()],
    [steamClips]
  );

  const uniqueVideoGameIds = useMemo(
    () =>
      [
        "all",
        ...Array.from(
          new Set(exportedVideos.map((v) => v.game_id ?? "").filter(Boolean))
        ).sort(),
      ],
    [exportedVideos]
  );

  const filteredClips = useMemo(
    () =>
      steamClips
        .filter(
          (c) =>
            (clipGameFilter === "all" || c.game_id === clipGameFilter) &&
            (clipTypeFilter === "all" || c.clip_type === clipTypeFilter)
        )
        .sort((a, b) =>
          clipSort === "size" ? b.size - a.size : b.modified - a.modified
        ),
    [steamClips, clipGameFilter, clipTypeFilter, clipSort]
  );

  const filteredExportedVideos = useMemo(
    () =>
      exportedVideos
        .filter(
          (v) => videoGameFilter === "all" || v.game_id === videoGameFilter
        )
        .sort((a, b) =>
          videoSort === "size" ? b.size - a.size : b.modified - a.modified
        ),
    [exportedVideos, videoGameFilter, videoSort]
  );

  // ── Game name helper ──────────────────────────────────────────────────────
  const gameName = useCallback(
    (gameId: string | undefined): string => {
      if (!gameId || gameId === "unknown" || gameId === "") return "Unknown Game";
      return gameNames[gameId] ?? `App ${gameId}`;
    },
    [gameNames]
  );

  // ── Loaders ──────────────────────────────────────────────────────────────
  const refreshVideos = useCallback(async () => {
    setLoading(true);
    try {
      const files = await getVideoFiles();
      setVideos(files);
    } catch {
      toaster.toast({ title: "Error", body: "Failed to load video files" });
    }
    // Game names are best-effort; don't block video list on failure
    try {
      const names = await getGameNames();
      setGameNames(names);
    } catch {
      // silently ignore — numeric App IDs will be shown as fallback
    }
    setLoading(false);
  }, []);

  const refreshAuthStatus = useCallback(async () => {
    try {
      const status = await checkAuth();
      setIsAuthenticated(status.authenticated);
    } catch {
      setIsAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    refreshVideos();
    refreshAuthStatus();
    getCredentials().then((creds) => {
      if (creds.client_id) {
        setClientId(creds.client_id);
        setUseCustomCredentials(true);
      }
      if (creds.client_secret) setClientSecret(creds.client_secret);
    });
    getSettings().then((s) => setPluginSettings(s));
  }, [refreshVideos, refreshAuthStatus]);

  // ── Event listeners ───────────────────────────────────────────────────────
  useEffect(() => {
    const conversionListener = addEventListener<[ConversionProgress]>(
      "conversion_progress",
      (progress) => {
        setConversionProgress(progress);
        setConverting(progress.status === "started" || progress.status === "converting");
        if (progress.status === "complete") {
          refreshVideos();
        }
      }
    );
    return () => {
      removeEventListener("conversion_progress", conversionListener);
    };
  }, [refreshVideos]);

  // ── Auth polling ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authPolling) return;
    const interval = setInterval(async () => {
      const result = await pollAuth();
      if (result.authenticated) {
        setAuthPolling(false);
        setAuthCode("");
        setAuthUrl("");
        setIsAuthenticated(true);
        toaster.toast({ title: "Connected!", body: "YouTube account linked successfully" });
      } else if (!result.pending) {
        setAuthPolling(false);
        toaster.toast({ title: "Auth Failed", body: result.error ?? "Authorization failed" });
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [authPolling]);

  // ── Settings handlers ─────────────────────────────────────────────────────
  const handleSaveCredentials = async () => {
    if (!clientId || !clientSecret) {
      toaster.toast({ title: "Error", body: "Please enter both Client ID and Client Secret" });
      return;
    }
    const result = await saveCredentials(clientId, clientSecret);
    if (result.success) {
      toaster.toast({ title: "Saved", body: "Credentials saved successfully" });
    } else {
      toaster.toast({ title: "Error", body: result.error ?? "Failed to save credentials" });
    }
  };

  const handleConnectYoutube = async () => {
    if (useCustomCredentials && (!clientId || !clientSecret)) {
      toaster.toast({
        title: "Error",
        body: "Please enter your Client ID and Client Secret first",
      });
      return;
    }
    // Pass custom credentials or empty strings to use built-in defaults
    const cid = useCustomCredentials ? clientId : "";
    const csecret = useCustomCredentials ? clientSecret : "";
    const result = await startAuth(cid, csecret);
    if (result.success) {
      setAuthCode(result.user_code ?? "");
      setAuthUrl(result.verification_url ?? "");
      setAuthPolling(true);
    } else {
      toaster.toast({ title: "Auth Error", body: result.error ?? "Failed to start auth" });
    }
  };

  const handleDisconnect = async () => {
    await revokeAuth();
    setIsAuthenticated(false);
    toaster.toast({ title: "Disconnected", body: "YouTube account unlinked" });
  };

  const handleToggleSubfolders = async () => {
    const next = { ...pluginSettings, use_game_subfolders: !pluginSettings.use_game_subfolders };
    const result = await saveSettings(next);
    if (result.success) {
      setPluginSettings(next);
    } else {
      toaster.toast({ title: "Error", body: result.error ?? "Failed to save settings" });
    }
  };

  // ── Upload handler ────────────────────────────────────────────────────────
  const handleSelectForUpload = (video: VideoFile) => {
    showModal(
      <UploadModal
        closeModal={() => {/* filled by showModal */}}
        video={video}
        authenticated={isAuthenticated}
      />
    );
  };

  // ── Clip handlers ─────────────────────────────────────────────────────────
  const handleExportClip = (clip: VideoFile) => {
    showModal(
      <ExportModal
        closeModal={() => {/* filled by showModal */}}
        clip={clip}
        gameName={gameName(clip.game_id)}
      />
    );
  };

  const handleDeleteClip = async (clip: VideoFile) => {
    const result = await deleteSteamClip(clip.path);
    if (result.success) {
      refreshVideos();
      toaster.toast({ title: "Deleted", body: `Clip "${clip.name}" deleted` });
    } else {
      toaster.toast({ title: "Error", body: result.error ?? "Failed to delete clip" });
    }
  };

  // ── Exported video handlers ───────────────────────────────────────────────
  const handleConvertVideo = async (video: VideoFile) => {
    setConversionProgress(null);
    const result = await convertToMp4(video.path, video.game_id ?? "", "", "medium");
    if (!result.success) {
      toaster.toast({
        title: "Conversion Error",
        body: result.error ?? "Failed to start conversion",
      });
    }
  };

  const handleDeleteVideo = async (video: VideoFile) => {
    const result = await deleteVideo(video.path);
    if (result.success) {
      refreshVideos();
      toaster.toast({ title: "Deleted", body: `"${video.name}" deleted` });
    } else {
      toaster.toast({ title: "Error", body: result.error ?? "Failed to delete video" });
    }
  };

  // ── Settings view ─────────────────────────────────────────────────────────
  if (view === "settings") {
    return (
      <>
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setView("list")}>
              Back
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="Export Settings">
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleToggleSubfolders}>
              Game Subfolders: {pluginSettings.use_game_subfolders ? "ON" : "OFF"}
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <div style={{ fontSize: "11px", color: "#aaa" }}>
              {pluginSettings.use_game_subfolders
                ? "Videos saved to ~/Videos/<game name>/"
                : "Videos saved to ~/Videos/"}
            </div>
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="YouTube Authentication">
          {isAuthenticated ? (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={handleDisconnect}>
                Disconnect YouTube Account
              </ButtonItem>
            </PanelSectionRow>
          ) : (
            <>
              {authCode ? (
                <>
                  <PanelSectionRow>
                    <div style={{ fontSize: "12px", wordBreak: "break-all" }}>
                      Visit: <strong>{authUrl}</strong>
                    </div>
                  </PanelSectionRow>
                  <PanelSectionRow>
                    <div
                      style={{
                        fontSize: "16px",
                        textAlign: "center",
                        padding: "8px",
                        letterSpacing: "4px",
                        fontWeight: "bold",
                      }}
                    >
                      {authCode}
                    </div>
                  </PanelSectionRow>
                  <PanelSectionRow>
                    <div style={{ fontSize: "12px", color: "#aaa" }}>
                      {authPolling ? "Waiting for authorization..." : "Enter this code above"}
                    </div>
                  </PanelSectionRow>
                </>
              ) : (
                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={handleConnectYoutube}>
                    Connect YouTube Account
                  </ButtonItem>
                </PanelSectionRow>
              )}

              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  onClick={() => setUseCustomCredentials(!useCustomCredentials)}
                >
                  {useCustomCredentials ? "Use Default Credentials" : "Use Custom Credentials (Advanced)"}
                </ButtonItem>
              </PanelSectionRow>

              {useCustomCredentials && (
                <>
                  <PanelSectionRow>
                    <div style={{ fontSize: "11px", color: "#aaa" }}>
                      Provide your own Google Cloud OAuth2 client credentials.
                    </div>
                  </PanelSectionRow>
                  <PanelSectionRow>
                    <TextField
                      label="Client ID"
                      description="From Google Cloud Console -> OAuth 2.0 Client IDs"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </PanelSectionRow>
                  <PanelSectionRow>
                    <TextField
                      label="Client Secret"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      bIsPassword
                    />
                  </PanelSectionRow>
                  <PanelSectionRow>
                    <ButtonItem layout="below" onClick={handleSaveCredentials}>
                      Save Credentials
                    </ButtonItem>
                  </PanelSectionRow>
                </>
              )}
            </>
          )}
        </PanelSection>
      </>
    );
  }

  // ── Steam Clips submenu ───────────────────────────────────────────────────
  if (view === "clips") {
    const typeLabel: Record<string, string> = {
      all: "All Types",
      clips: "Manual Clips",
      video: "Background Recordings",
    };
    const typeOptions: Array<"all" | "clips" | "video"> = ["all", "clips", "video"];

    return (
      <>
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setView("list")}>
              Back
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={refreshVideos} disabled={loading}>
              {loading ? "Scanning..." : "Refresh"}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="Filters">
          <InlineSelect
            label="Game"
            value={clipGameFilter}
            options={uniqueClipGameIds.map((g) => ({
              value: g,
              label: g === "all" ? "All Games" : gameName(g),
            }))}
            onChange={(v) => setClipGameFilter(v)}
          />
          <InlineSelect
            label="Type"
            value={clipTypeFilter}
            options={typeOptions.map((v) => ({ value: v, label: typeLabel[v] }))}
            onChange={(v) => setClipTypeFilter(v)}
          />
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => setClipSort((s) => s === "date" ? "size" : "date")}
            >
              Sort: {clipSort === "date" ? "Date" : "File Size"}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>

        {converting && conversionProgress && (
          <PanelSection title="Converting">
            <PanelSectionRow>
              <ProgressBarWithInfo
                nProgress={conversionProgress.progress ?? 0}
                sOperationText={
                  conversionProgress.status === "complete" ? "Complete!" :
                  conversionProgress.status === "error" ? "Error" : "Converting..."
                }
                sTimeRemaining={`${conversionProgress.progress ?? 0}%`}
              />
            </PanelSectionRow>
          </PanelSection>
        )}

        <PanelSection title={`Steam Clips (${filteredClips.length})`}>
          {filteredClips.length === 0 && !loading && (
            <PanelSectionRow>
              <div style={{ fontSize: "12px", color: "#aaa" }}>
                No clips found. Steam records clips in gamerecordings/clips or video.
              </div>
            </PanelSectionRow>
          )}
          {filteredClips.map((clip) => (
            <PanelSection key={clip.path}>
              <PanelSectionRow>
                <div style={{ fontSize: "12px", fontWeight: "bold" }}>
                  {gameName(clip.game_id)}
                  <span
                    style={{
                      marginLeft: "8px",
                      fontSize: "11px",
                      color: clip.clip_type === "video" ? "#aaa" : "#4fc3f7",
                      fontWeight: "normal",
                    }}
                  >
                    {clip.clip_type === "video" ? "Background" : "Manual Clip"}
                  </span>
                </div>
              </PanelSectionRow>
              <PanelSectionRow>
                <div style={{ fontSize: "11px", color: "#aaa" }}>
                  {formatSize(clip.size)} · {formatDate(clip.modified)}
                </div>
              </PanelSectionRow>

              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  onClick={() => handleExportClip(clip)}
                  disabled={converting}
                >
                  {converting ? "Converting..." : "Export to MP4"}
                </ButtonItem>
              </PanelSectionRow>

              <PanelSectionRow>
                <ButtonItem layout="below" onClick={() => handleDeleteClip(clip)} disabled={converting}>
                  Delete Clip
                </ButtonItem>
              </PanelSectionRow>
            </PanelSection>
          ))}
        </PanelSection>
      </>
    );
  }

  // ── Exported Videos submenu ───────────────────────────────────────────────
  if (view === "videos") {
    return (
      <>
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setView("list")}>
              Back
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={refreshVideos} disabled={loading}>
              {loading ? "Scanning..." : "Refresh"}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="Filter">
          {uniqueVideoGameIds.length > 1 && (
            <InlineSelect
              label="Game"
              value={videoGameFilter}
              options={uniqueVideoGameIds.map((g) => ({
                value: g,
                label: g === "all" ? "All Games" : gameName(g),
              }))}
              onChange={(v) => setVideoGameFilter(v)}
            />
          )}
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => setVideoSort((s) => s === "date" ? "size" : "date")}
            >
              Sort: {videoSort === "date" ? "Date" : "File Size"}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title={`Exported Videos (${filteredExportedVideos.length})`}>
          {filteredExportedVideos.length === 0 && !loading && (
            <PanelSectionRow>
              <div style={{ fontSize: "12px", color: "#aaa" }}>
                No exported videos found. Export Steam clips or check ~/Videos.
              </div>
            </PanelSectionRow>
          )}
          {converting && conversionProgress && view === "videos" && (
            <PanelSectionRow>
              <ProgressBarWithInfo
                nProgress={conversionProgress.progress ?? 0}
                sOperationText={
                  conversionProgress.status === "complete" ? "Complete!" :
                  conversionProgress.status === "error" ? "Error" : "Converting..."
                }
                sTimeRemaining={`${conversionProgress.progress ?? 0}%`}
              />
            </PanelSectionRow>
          )}
          {filteredExportedVideos.map((video) => (
            <PanelSection key={video.path}>
              <PanelSectionRow>
                <div style={{ fontSize: "12px", fontWeight: "bold", wordBreak: "break-all" }}>
                  {video.name}
                </div>
              </PanelSectionRow>
              <PanelSectionRow>
                <div style={{ fontSize: "11px", color: "#aaa" }}>
                  {video.game_id ? `${gameName(video.game_id)} · ` : ""}
                  {formatSize(video.size)} · {video.ext.toUpperCase()}
                </div>
              </PanelSectionRow>
              <PanelSectionRow>
                <div style={{ fontSize: "10px", color: "#777", wordBreak: "break-all" }}>
                  {video.path}
                </div>
              </PanelSectionRow>
              {video.needs_conversion && (
                <PanelSectionRow>
                  <ButtonItem
                    layout="below"
                    onClick={() => handleConvertVideo(video)}
                    disabled={converting}
                  >
                    {converting ? "Converting..." : "Convert to MP4"}
                  </ButtonItem>
                </PanelSectionRow>
              )}
              <PanelSectionRow>
                <ButtonItem layout="below" onClick={() => handleSelectForUpload(video)}>
                  Upload to YouTube
                </ButtonItem>
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem layout="below" onClick={() => handleDeleteVideo(video)}>
                  Delete
                </ButtonItem>
              </PanelSectionRow>
            </PanelSection>
          ))}
        </PanelSection>
      </>
    );
  }

  // ── Main list view ────────────────────────────────────────────────────────
  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setView("settings")}>
            Settings
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "12px", color: isAuthenticated ? "#8bc34a" : "#aaa", textAlign: "center" }}>
            {isAuthenticated ? "YouTube connected" : "YouTube not connected"}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "11px", color: "#888", textAlign: "center", lineHeight: "1.6" }}>
            {steamClips.length} clip{steamClips.length !== 1 ? "s" : ""} ({formatSize(steamClips.reduce((sum, c) => sum + c.size, 0))})
            {" · "}
            {exportedVideos.length} video{exportedVideos.length !== 1 ? "s" : ""} ({formatSize(exportedVideos.reduce((sum, v) => sum + v.size, 0))})
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setView("clips")}>
            Steam Clips ({steamClips.length})
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setView("videos")}>
            Exported Videos ({exportedVideos.length})
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={refreshVideos} disabled={loading}>
            {loading ? "Scanning..." : "Refresh"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------
export default definePlugin(() => {
  console.log("Video Uploader plugin initializing");

  let lastUploadMilestone = 0;
  const uploadListener = addEventListener<[UploadProgress]>(
    "upload_progress",
    (progress) => {
      if (progress.status === "uploading" && progress.progress != null) {
        // Show toast at 25% milestones
        const milestone = Math.floor(progress.progress / 25) * 25;
        if (milestone > 0 && milestone > lastUploadMilestone) {
          lastUploadMilestone = milestone;
          toaster.toast({
            title: "Uploading...",
            body: `Upload progress: ${milestone}%`,
          });
        }
      } else if (progress.status === "complete") {
        lastUploadMilestone = 0;
        toaster.toast({
          title: "Upload Complete!",
          body: `Video uploaded: ${progress.video_url}`,
        });
      } else if (progress.status === "error") {
        lastUploadMilestone = 0;
        toaster.toast({
          title: "Upload Failed",
          body: progress.error ?? "Unknown error",
        });
      }
    }
  );

  let lastConversionMilestone = 0;
  const conversionListener = addEventListener<[ConversionProgress]>(
    "conversion_progress",
    (progress) => {
      if (progress.status === "converting" && progress.progress != null) {
        const milestone = Math.floor(progress.progress / 25) * 25;
        if (milestone > 0 && milestone > lastConversionMilestone) {
          lastConversionMilestone = milestone;
          toaster.toast({
            title: "Converting...",
            body: `Conversion progress: ${milestone}%`,
          });
        }
      } else if (progress.status === "complete") {
        lastConversionMilestone = 0;
        toaster.toast({
          title: "Conversion Complete",
          body: `Saved to: ${progress.output_path}`,
        });
      } else if (progress.status === "error") {
        lastConversionMilestone = 0;
        toaster.toast({
          title: "Conversion Failed",
          body: progress.error ?? "Unknown error",
        });
      }
    }
  );

  return {
    name: "Video Uploader",
    titleView: <div className={staticClasses.Title}>Video Uploader</div>,
    content: <Content />,
    icon: <FaYoutube />,
    onDismount() {
      removeEventListener("upload_progress", uploadListener);
      removeEventListener("conversion_progress", conversionListener);
    },
  };
});
