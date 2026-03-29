import {
  ButtonItem,
  ConfirmModal,
  DialogBody,
  DialogButton,
  DropdownItem,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ProgressBarWithInfo,
  showModal,
  TextField,
  ToggleField,
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
import { FaSyncAlt, FaTrash, FaYoutube } from "react-icons/fa";

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
  subfolder?: string;
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

const PRIVACY_OPTIONS = [
  { data: "private" as const, label: "Private" },
  { data: "unlisted" as const, label: "Unlisted" },
  { data: "public" as const, label: "Public" },
];

const CLIP_TYPE_LABELS: Record<string, string> = {
  all: "All Types",
  clips: "Manual Clips",
  video: "Background Recordings",
};
const CLIP_TYPE_OPTIONS: Array<"all" | "clips" | "video"> = ["all", "clips", "video"];

const ICON_BUTTON_STYLE = {
  minWidth: 0,
  width: "auto",
  padding: "0 12px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

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
          rgOptions={PRIVACY_OPTIONS}
          selectedOption={privacy}
          onChange={(opt) => setPrivacy(opt.data)}
        />
      </DialogBody>
    </ConfirmModal>
  );
}

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

// Steam's DropdownItem opens a full-screen modal and closes the QAM panel,
// so we use a simple inline option list instead.
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
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  const converting = conversionProgress?.status === "started" || conversionProgress?.status === "converting";

  // Clip filters
  const [clipGameFilter, setClipGameFilter] = useState("all");
  const [clipTypeFilter, setClipTypeFilter] = useState<"all" | "clips" | "video">("all");

  // Exported video filters
  const [videoGameFilter, setVideoGameFilter] = useState("all");

  // Sort
  const [clipSort, setClipSort] = useState<"date" | "size">("date");
  const [videoSort, setVideoSort] = useState<"date" | "size">("date");

  const steamClips = useMemo(() => videos.filter((v) => v.is_steam_clip), [videos]);
  const exportedVideos = useMemo(() => videos.filter((v) => !v.is_steam_clip), [videos]);

  const uniqueClipGameIds = useMemo(
    () =>
      ["all", ...Array.from(new Set(steamClips.map((c) => c.game_id ?? "unknown"))).sort()],
    [steamClips]
  );

  const hasMultipleClipTypes = useMemo(
    () => new Set(steamClips.map((c) => c.clip_type)).size > 1,
    [steamClips]
  );

  const totalClipSize = useMemo(() => steamClips.reduce((sum, c) => sum + c.size, 0), [steamClips]);
  const totalVideoSize = useMemo(() => exportedVideos.reduce((sum, v) => sum + v.size, 0), [exportedVideos]);

  const videoGroupKey = useCallback(
    (v: VideoFile) => v.subfolder || v.game_id || "",
    []
  );

  const uniqueVideoGroups = useMemo(
    () =>
      [
        "all",
        ...Array.from(
          new Set(exportedVideos.map(videoGroupKey).filter(Boolean))
        ).sort(),
      ],
    [exportedVideos, videoGroupKey]
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
          (v) => videoGameFilter === "all" || videoGroupKey(v) === videoGameFilter
        )
        .sort((a, b) =>
          videoSort === "size" ? b.size - a.size : b.modified - a.modified
        ),
    [exportedVideos, videoGameFilter, videoSort, videoGroupKey]
  );

  const gameName = useCallback(
    (gameId: string | undefined): string => {
      if (!gameId || gameId === "unknown" || gameId === "") return "Unknown Game";
      return gameNames[gameId] ?? `App ${gameId}`;
    },
    [gameNames]
  );

  const refreshVideos = useCallback(async () => {
    setLoading(true);
    const [filesResult, namesResult] = await Promise.allSettled([
      getVideoFiles(),
      getGameNames(),
    ]);
    if (filesResult.status === "fulfilled") {
      setVideos(filesResult.value);
    } else {
      toaster.toast({ title: "Error", body: "Failed to load video files" });
    }
    if (namesResult.status === "fulfilled") {
      setGameNames(namesResult.value);
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

  useEffect(() => {
    const conversionListener = addEventListener<[ConversionProgress]>(
      "conversion_progress",
      (progress) => {
        setConversionProgress(progress);
        if (progress.status === "complete") {
          refreshVideos();
        }
      }
    );
    return () => {
      removeEventListener("conversion_progress", conversionListener);
    };
  }, [refreshVideos]);

  useEffect(() => {
    if (!authPolling) return;
    const interval = setInterval(async () => {
      try {
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
      } catch {
        setAuthPolling(false);
        toaster.toast({ title: "Auth Error", body: "Lost connection to backend" });
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [authPolling]);

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

  const handleToggleSubfolders = async (checked: boolean) => {
    const next = { ...pluginSettings, use_game_subfolders: checked };
    const result = await saveSettings(next);
    if (result.success) {
      setPluginSettings(next);
    } else {
      toaster.toast({ title: "Error", body: result.error ?? "Failed to save settings" });
    }
  };

  const handleSelectForUpload = (video: VideoFile) => {
    showModal(
      <UploadModal
        closeModal={() => {/* filled by showModal */}}
        video={video}
        authenticated={isAuthenticated}
      />
    );
  };

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
            <ToggleField
              label="Game Subfolders"
              description={pluginSettings.use_game_subfolders
                ? "Videos saved to ~/Videos/<game name>/"
                : "Videos saved to ~/Videos/"}
              checked={pluginSettings.use_game_subfolders}
              onChange={handleToggleSubfolders}
            />
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

  if (view === "clips") {
    return (
      <>
        <PanelSection>
          <PanelSectionRow>
            <Focusable style={{ display: "flex", gap: "8px" }}>
              <DialogButton onClick={() => setView("list")} style={{ flex: 1, minWidth: 0 }}>
                Back
              </DialogButton>
              <DialogButton onClick={refreshVideos} disabled={loading} style={ICON_BUTTON_STYLE}>
                {loading ? "..." : <FaSyncAlt />}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="Filters">
          {uniqueClipGameIds.length > 2 && (
            <InlineSelect
              label="Game"
              value={clipGameFilter}
              options={uniqueClipGameIds.map((g) => ({
                value: g,
                label: g === "all" ? "All Games" : gameName(g),
              }))}
              onChange={(v) => setClipGameFilter(v)}
            />
          )}
          {hasMultipleClipTypes && (
            <InlineSelect
              label="Type"
              value={clipTypeFilter}
              options={CLIP_TYPE_OPTIONS.map((v) => ({ value: v, label: CLIP_TYPE_LABELS[v] }))}
              onChange={(v) => setClipTypeFilter(v)}
            />
          )}
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
                    {clip.clip_type === "video" ? "Background" : "Clip"}
                  </span>
                  <span style={{ marginLeft: "8px", fontSize: "11px", color: "#aaa", fontWeight: "normal" }}>
                    {formatSize(clip.size)} · {formatDate(clip.modified)}
                  </span>
                </div>
              </PanelSectionRow>
              <PanelSectionRow>
                <Focusable style={{ display: "flex", gap: "8px" }}>
                  <DialogButton
                    onClick={() => handleExportClip(clip)}
                    disabled={converting}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {converting ? "Converting..." : "Export to MP4"}
                  </DialogButton>
                  <DialogButton
                    onClick={() => handleDeleteClip(clip)}
                    disabled={converting}
                    style={ICON_BUTTON_STYLE}
                  >
                    <FaTrash />
                  </DialogButton>
                </Focusable>
              </PanelSectionRow>
            </PanelSection>
          ))}
        </PanelSection>
      </>
    );
  }

  if (view === "videos") {
    return (
      <>
        <PanelSection>
          <PanelSectionRow>
            <Focusable style={{ display: "flex", gap: "8px" }}>
              <DialogButton onClick={() => setView("list")} style={{ flex: 1, minWidth: 0 }}>
                Back
              </DialogButton>
              <DialogButton onClick={refreshVideos} disabled={loading} style={ICON_BUTTON_STYLE}>
                {loading ? "..." : <FaSyncAlt />}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="Filter">
          {uniqueVideoGroups.length > 2 && (
            <InlineSelect
              label="Game"
              value={videoGameFilter}
              options={uniqueVideoGroups.map((g) => ({
                value: g,
                label: g === "all" ? "All" : (/^\d+$/.test(g) ? gameName(g) : g),
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
          {converting && conversionProgress && (
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
                <div style={{ fontSize: "11px", color: "#aaa" }}>
                  {video.subfolder ? `${video.subfolder} · ` : video.game_id ? `${gameName(video.game_id)} · ` : ""}
                  {formatSize(video.size)} · {video.ext.toUpperCase()}
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
                <Focusable style={{ display: "flex", gap: "8px" }}>
                  <DialogButton
                    onClick={() => handleSelectForUpload(video)}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    Upload
                  </DialogButton>
                  <DialogButton
                    onClick={() => handleDeleteVideo(video)}
                    style={ICON_BUTTON_STYLE}
                  >
                    <FaTrash />
                  </DialogButton>
                </Focusable>
              </PanelSectionRow>
            </PanelSection>
          ))}
        </PanelSection>
      </>
    );
  }

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
            {steamClips.length} clip{steamClips.length !== 1 ? "s" : ""} ({formatSize(totalClipSize)})
            {" · "}
            {exportedVideos.length} video{exportedVideos.length !== 1 ? "s" : ""} ({formatSize(totalVideoSize)})
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
            {loading ? "Scanning..." : <span style={{ display: "inline-flex", alignItems: "center" }}><FaSyncAlt style={{ marginRight: "8px" }} /> Refresh</span>}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  console.log("Video Uploader plugin initializing");

  function milestoneToaster<T extends { status: string; progress?: number; error?: string }>(config: {
    activeStatus: string;
    activeTitle: string;
    completeTitle: string;
    completeBody: (p: T) => string;
  }) {
    let lastMilestone = 0;
    return (progress: T) => {
      if (progress.status === config.activeStatus && progress.progress != null) {
        const milestone = Math.floor(progress.progress / 25) * 25;
        if (milestone > 0 && milestone > lastMilestone) {
          lastMilestone = milestone;
          toaster.toast({ title: config.activeTitle, body: `Progress: ${milestone}%` });
        }
      } else if (progress.status === "complete") {
        lastMilestone = 0;
        toaster.toast({ title: config.completeTitle, body: config.completeBody(progress) });
      } else if (progress.status === "error") {
        lastMilestone = 0;
        toaster.toast({ title: `${config.completeTitle.split(" ")[0]} Failed`, body: progress.error ?? "Unknown error" });
      }
    };
  }

  const uploadListener = addEventListener<[UploadProgress]>(
    "upload_progress",
    milestoneToaster<UploadProgress>({
      activeStatus: "uploading",
      activeTitle: "Uploading...",
      completeTitle: "Upload Complete!",
      completeBody: (p) => `Video uploaded: ${p.video_url}`,
    })
  );

  const conversionListener = addEventListener<[ConversionProgress]>(
    "conversion_progress",
    milestoneToaster<ConversionProgress>({
      activeStatus: "converting",
      activeTitle: "Converting...",
      completeTitle: "Conversion Complete",
      completeBody: (p) => `Saved to: ${p.output_path}`,
    })
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
