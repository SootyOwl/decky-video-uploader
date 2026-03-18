import os
import re
import glob
import shutil
import tempfile
import asyncio
import json
import time
import ssl
import http.client
import urllib.request
import urllib.parse
import urllib.error

import decky

# ---------------------------------------------------------------------------
# SSL context — Steam Deck (Arch-based) may ship a Python that cannot find
# the system CA bundle automatically.  We try several common locations so
# that urllib / http.client HTTPS calls succeed without disabling verification.
# ---------------------------------------------------------------------------
def _make_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    # If the default context already has CA certs loaded, just use it.
    try:
        ctx.load_default_locations()
    except Exception:
        pass
    # Probe well-known CA bundle paths (Arch, Fedora, Debian, Alpine, etc.)
    _CA_PATHS = [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
        "/usr/share/ca-certificates",
        "/etc/ssl/certs",
    ]
    for p in _CA_PATHS:
        try:
            if os.path.isfile(p):
                ctx.load_verify_locations(cafile=p)
                return ctx
            elif os.path.isdir(p):
                ctx.load_verify_locations(capath=p)
                return ctx
        except Exception:
            continue
    # Last resort: try certifi if installed
    try:
        import certifi
        ctx.load_verify_locations(cafile=certifi.where())
        return ctx
    except Exception:
        pass
    return ctx

SSL_CTX = _make_ssl_context()

# ---------------------------------------------------------------------------
# YouTube API constants
# ---------------------------------------------------------------------------
YOUTUBE_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code"
YOUTUBE_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload"

# Default OAuth2 credentials (TV & Limited Input device client).
# Replace these with your own values from the Google Cloud Console.
# For device-flow clients the secret is not truly confidential — Google
# documents that it may be embedded in distributed applications.
DEFAULT_CLIENT_ID = "267858990226-t964tp8m6oina39elk8obk2fq0h8sdar.apps.googleusercontent.com"
DEFAULT_CLIENT_SECRET = "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"

# Supported video file extensions
VIDEO_EXTENSIONS = frozenset([".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".ts"])

# Chunk size for YouTube resumable uploads (8 MB must be a multiple of 256 KB)
UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024


class Plugin:
    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def _main(self):
        self._auth_state: dict = {}
        self._loop = asyncio.get_event_loop()
        decky.logger.info("Video Uploader plugin loaded")
        self._videos_dir()  # ensure ~/Videos/ exists

    async def _unload(self):
        decky.logger.info("Video Uploader plugin unloaded")

    async def _uninstall(self):
        pass

    async def _migration(self):
        pass

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _videos_dir(self, game_subfolder: str = "") -> str:
        """Output directory for exported / converted videos.

        If *game_subfolder* is provided **and** the ``use_game_subfolders``
        setting is enabled the video is written under ``~/Videos/<subfolder>/``.
        """
        base = os.path.join(decky.DECKY_USER_HOME, "Videos")
        if game_subfolder and self._load_settings().get("use_game_subfolders", True):
            # Strip control chars, replace reserved path characters, strip
            # again after truncating so the name never ends with a space/dot
            cleaned = "".join(c for c in game_subfolder if ord(c) >= 32)
            safe_name = re.sub(r'[<>:"/\\|?*]', "_", cleaned).strip(" .")[:64].strip(" .")
            if safe_name:
                path = os.path.join(base, safe_name)
                os.makedirs(path, exist_ok=True)
                return path
        os.makedirs(base, exist_ok=True)
        return base

    def _creds_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "client_credentials.json")

    def _token_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "youtube_token.json")

    def _settings_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

    def _load_settings(self) -> dict:
        try:
            if os.path.isfile(self._settings_path()):
                with open(self._settings_path()) as fh:
                    return json.load(fh)
        except Exception:
            pass
        return {"use_game_subfolders": True}

    async def get_settings(self) -> dict:
        """Return plugin settings."""
        return self._load_settings()

    async def save_settings(self, settings: dict) -> dict:
        """Persist plugin settings."""
        try:
            with open(self._settings_path(), "w") as fh:
                json.dump(settings, fh)
            return {"success": True}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------
    # Video discovery
    # ------------------------------------------------------------------

    @staticmethod
    def _read_acf_name(path: str):
        """Return the game name from a Steam appmanifest_*.acf file, or None."""
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    m = re.search(r'"name"\s+"([^"]+)"', line)
                    if m:
                        return m.group(1)
        except Exception:
            pass
        return None

    async def get_game_names(self) -> dict:
        """Return a mapping of app_id (string) → game name from local appmanifest files."""
        user_home = decky.DECKY_USER_HOME
        names: dict = {}
        steamapps_dirs = [
            os.path.join(user_home, ".local", "share", "Steam", "steamapps"),
            os.path.join(user_home, ".steam", "steam", "steamapps"),
            # Flatpak install
            os.path.join(
                user_home,
                ".var", "app", "com.valvesoftware.Steam",
                "data", "Steam", "steamapps",
            ),
        ]
        for steamapps_dir in steamapps_dirs:
            if not os.path.isdir(steamapps_dir):
                continue
            for manifest in glob.glob(os.path.join(steamapps_dir, "appmanifest_*.acf")):
                base = os.path.basename(manifest)
                app_id = base.replace("appmanifest_", "").replace(".acf", "")
                if not app_id.isdigit():
                    continue
                name = Plugin._read_acf_name(manifest)
                if name:
                    names[app_id] = name
        return names

    def _get_custom_record_path(self, userdata_dir: str):
        """Read a custom Steam recording path from localconfig.vdf, if set."""
        localconfig = os.path.join(userdata_dir, "config", "localconfig.vdf")
        if not os.path.isfile(localconfig):
            return None
        try:
            with open(localconfig, "r", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if '"BackgroundRecordPath"' in line:
                        parts = line.split('"BackgroundRecordPath"', 1)
                        if len(parts) > 1:
                            value = parts[1].strip().strip('"')
                            if value:
                                return value
        except Exception:
            pass
        return None

    @staticmethod
    def _parse_clip_game_id(folder_name: str) -> str:
        """Extract the Steam App ID from a recording folder name (best-effort).

        Steam recording folder names follow the pattern:
        ``{prefix}_{appid}_{YYYYMMDD}_{HHMMSS}``
        """
        parts = folder_name.split("_")
        if len(parts) >= 2 and parts[1].isdigit():
            return parts[1]
        if parts[0].isdigit():
            return parts[0]
        return "unknown"

    def _steam_userdata_bases(self) -> list:
        """Return all candidate Steam userdata directory bases (deduplicated)."""
        user_home = decky.DECKY_USER_HOME
        candidates = [
            os.path.join(user_home, ".local", "share", "Steam", "userdata"),
            os.path.join(user_home, ".steam", "steam", "userdata"),
            # Flatpak install
            os.path.join(
                user_home,
                ".var", "app", "com.valvesoftware.Steam",
                "data", "Steam", "userdata",
            ),
        ]
        seen: set = set()
        result: list = []
        for p in candidates:
            real = os.path.realpath(p)
            if real not in seen:
                seen.add(real)
                result.append(p)
        return result

    def _discover_steam_clips(self) -> list:
        """Return clip-folder entries for Steam's internal MPEG-DASH game recordings.

        Each entry has ``is_steam_clip=True`` and ``needs_conversion=True``.
        The *path* field is the clip folder (a directory, not a file).
        """
        user_home = decky.DECKY_USER_HOME
        clips: list = []

        for steam_base in self._steam_userdata_bases():
            if not os.path.isdir(steam_base):
                continue
            try:
                for uid_entry in os.scandir(steam_base):
                    if not uid_entry.is_dir():
                        continue
                    userdata_dir = uid_entry.path

                    record_roots = [os.path.join(userdata_dir, "gamerecordings")]
                    custom = self._get_custom_record_path(userdata_dir)
                    if custom and os.path.isdir(custom):
                        record_roots.append(custom)

                    for record_root in record_roots:
                        for subdir in ("clips", "video"):
                            clip_parent = os.path.join(record_root, subdir)
                            if not os.path.isdir(clip_parent):
                                continue
                            try:
                                for clip_entry in os.scandir(clip_parent):
                                    if not clip_entry.is_dir():
                                        continue
                                    clip_folder = clip_entry.path
                                    # Recursively search for session.mpd (matches
                                    # SteamClip's approach -- manual clips may nest
                                    # session data at varying depths).
                                    has_mpd = any(
                                        "session.mpd" in files
                                        for _root, _dirs, files in os.walk(clip_folder)
                                    )
                                    if not has_mpd:
                                        continue
                                    total_size = sum(
                                        os.path.getsize(os.path.join(r, f))
                                        for r, _d, fs in os.walk(clip_folder)
                                        for f in fs
                                        if f.endswith(".m4s")
                                    )
                                    try:
                                        mtime = clip_entry.stat().st_mtime
                                    except OSError:
                                        mtime = 0.0
                                    clip_name = os.path.basename(clip_folder)
                                    clips.append(
                                        {
                                            "path": clip_folder,
                                            "name": clip_name,
                                            "size": total_size,
                                            "modified": mtime,
                                            "ext": "steam_clip",
                                            "needs_conversion": True,
                                            "is_steam_clip": True,
                                            "game_id": Plugin._parse_clip_game_id(clip_name),
                                            "clip_type": subdir,
                                        }
                                    )
                            except PermissionError:
                                pass
            except PermissionError:
                pass

        return clips

    async def get_video_files(self) -> list:
        """Return a list of video files found in Steam / user video directories,
        including unexported Steam game recording clips."""
        user_home = decky.DECKY_USER_HOME
        search_roots: list = [os.path.join(user_home, "Videos")]

        for steam_base in self._steam_userdata_bases():
            if not os.path.isdir(steam_base):
                continue
            try:
                for entry in os.scandir(steam_base):
                    if not entry.is_dir():
                        continue
                    candidate = os.path.join(entry.path, "760", "remote")
                    if os.path.isdir(candidate) and candidate not in search_roots:
                        search_roots.append(candidate)
            except PermissionError:
                pass

        videos = []
        for root in search_roots:
            if not os.path.isdir(root):
                continue
            try:
                for dirpath, _dirs, filenames in os.walk(root):
                    for fname in filenames:
                        ext = os.path.splitext(fname)[1].lower()
                        if ext not in VIDEO_EXTENSIONS:
                            continue
                        fpath = os.path.join(dirpath, fname)
                        try:
                            st = os.stat(fpath)
                            # Extract game App ID from Steam 760/remote/<appid>/... paths
                            # using a regex match on the normalised path
                            game_id = ""
                            m = re.search(
                                r"[/\\]760[/\\]remote[/\\](\d+)[/\\]", fpath
                            )
                            if m:
                                game_id = m.group(1)
                            videos.append(
                                {
                                    "path": fpath,
                                    "name": fname,
                                    "size": st.st_size,
                                    "modified": st.st_mtime,
                                    "ext": ext,
                                    "needs_conversion": ext != ".mp4",
                                    "is_steam_clip": False,
                                    "game_id": game_id,
                                }
                            )
                        except OSError:
                            pass
            except PermissionError:
                pass

        # Include unexported Steam game recording clips
        videos.extend(self._discover_steam_clips())

        videos.sort(key=lambda v: v["modified"], reverse=True)
        return videos

    # ------------------------------------------------------------------
    # MP4 conversion (runs as a background asyncio task)
    # ------------------------------------------------------------------

    async def convert_to_mp4(self, source_path: str, game_id: str = "") -> dict:
        """Convert a video to H.264/AAC MP4 using ffmpeg.

        Returns immediately; emits *conversion_progress* events when done.
        """
        if not os.path.isfile(source_path):
            return {"success": False, "error": "Source file not found"}
        # Resolve game name for subfolder (best-effort from game_id or source path)
        game_name = ""
        if game_id and game_id.isdigit():
            names = await self.get_game_names()
            game_name = names.get(game_id, game_id)
        asyncio.get_event_loop().create_task(self._run_conversion(source_path, game_name))
        return {"success": True, "started": True}

    async def _run_conversion(self, source_path: str, game_name: str = "") -> None:
        out_dir = self._videos_dir(game_name)
        base = os.path.splitext(os.path.basename(source_path))[0]
        output_path = os.path.join(out_dir, f"{base}.mp4")
        counter = 1
        while os.path.exists(output_path):
            output_path = os.path.join(out_dir, f"{base}_{counter}.mp4")
            counter += 1

        await decky.emit("conversion_progress", {"status": "started", "source": source_path})
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-y",
                "-i",
                source_path,
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "22",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                output_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await proc.communicate()
            if proc.returncode == 0:
                await decky.emit(
                    "conversion_progress",
                    {
                        "status": "complete",
                        "output_path": output_path,
                        "size": os.path.getsize(output_path),
                    },
                )
            else:
                err = stderr.decode("utf-8", errors="replace")[-500:]
                await decky.emit(
                    "conversion_progress",
                    {"status": "error", "error": f"ffmpeg error: {err}"},
                )
        except FileNotFoundError:
            await decky.emit(
                "conversion_progress",
                {"status": "error", "error": "ffmpeg not found. Please install ffmpeg."},
            )
        except Exception as exc:
            await decky.emit("conversion_progress", {"status": "error", "error": str(exc)})

    # ------------------------------------------------------------------
    # Steam clip conversion (m4s MPEG-DASH → MP4)
    # ------------------------------------------------------------------

    async def convert_steam_clip(self, clip_folder: str, game_id: str = "") -> dict:
        """Convert a Steam internal MPEG-DASH game recording to MP4.

        *clip_folder* must be a directory containing a ``session.mpd`` file.
        Returns immediately; emits *conversion_progress* events when done.
        """
        if not os.path.isdir(clip_folder):
            return {"success": False, "error": "Clip folder not found"}
        # Look up game name for subfolder
        game_name = ""
        if game_id and game_id.isdigit():
            names = await self.get_game_names()
            game_name = names.get(game_id, game_id)
        asyncio.get_event_loop().create_task(
            self._run_steam_clip_conversion(clip_folder, game_name)
        )
        return {"success": True, "started": True}

    async def delete_steam_clip(self, clip_folder: str) -> dict:
        """Delete a Steam game recording clip folder.

        Safety checks:
        - The normalised path must be a directory.
        - It must sit inside a known Steam userdata/gamerecordings tree so that
          a malicious path like ``/tmp/gamerecordings/../important`` is rejected.
        """
        safe_path = os.path.normpath(clip_folder)
        if not os.path.isdir(safe_path):
            return {"success": False, "error": "Clip folder not found"}

        user_home = decky.DECKY_USER_HOME
        allowed_bases = [
            os.path.normpath(b) for b in self._steam_userdata_bases()
        ]
        if not any(safe_path.startswith(base + os.sep) for base in allowed_bases):
            return {"success": False, "error": "Path is not inside a known Steam userdata directory"}
        if "gamerecordings" not in safe_path:
            return {"success": False, "error": "Path does not look like a Steam recording"}

        try:
            shutil.rmtree(safe_path)
            return {"success": True}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def delete_video(self, filepath: str) -> dict:
        """Delete an exported video file.

        Safety check: the file must be under the user's home directory and
        must not be a directory.
        """
        safe_path = os.path.realpath(os.path.normpath(filepath))
        user_home = os.path.realpath(os.path.normpath(decky.DECKY_USER_HOME))
        if not safe_path.startswith(user_home + os.sep):
            return {"success": False, "error": "File is not inside the user home directory"}
        if not os.path.isfile(safe_path):
            return {"success": False, "error": "File not found"}
        try:
            os.unlink(safe_path)
            # Atomically remove parent dir if it's an empty game subfolder.
            # Skip the listdir check to avoid a TOCTOU race — os.rmdir already
            # fails atomically with ENOTEMPTY if the directory is not empty.
            parent = os.path.dirname(safe_path)
            videos_base = os.path.join(user_home, "Videos")
            if parent != videos_base:
                try:
                    os.rmdir(parent)
                except OSError:
                    pass
            return {"success": True}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def _ffmpeg_concat(self, file_list: list, is_video: bool) -> str:
        """Concatenate multiple MP4 segments with ffmpeg; returns path to output file."""
        list_tmp = tempfile.NamedTemporaryFile(
            delete=False, mode="w", suffix=".txt"
        )
        for path in file_list:
            list_tmp.write(f"file '{path}'\n")
        list_tmp.close()
        out_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
        out_path = out_tmp.name
        out_tmp.close()
        try:
            args = [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", list_tmp.name, "-c", "copy",
            ]
            if is_video:
                args.extend(["-movflags", "+faststart", "-max_muxing_queue_size", "1024"])
            args.append(out_path)
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _out, err = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(
                    "ffmpeg concat failed: "
                    + err.decode("utf-8", errors="replace")[-300:]
                )
        finally:
            try:
                os.unlink(list_tmp.name)
            except OSError:
                pass
        return out_path

    async def _run_steam_clip_conversion(self, clip_folder: str, game_name: str = "") -> None:
        out_dir = self._videos_dir(game_name)
        clip_name = os.path.basename(clip_folder)
        output_path = os.path.join(out_dir, f"{clip_name}.mp4")
        counter = 1
        while os.path.exists(output_path):
            output_path = os.path.join(out_dir, f"{clip_name}_{counter}.mp4")
            counter += 1

        await decky.emit("conversion_progress", {"status": "started", "source": clip_folder})
        temp_files: list = []
        try:
            # Find all session directories (one per recording segment)
            session_dirs = sorted(
                root
                for root, _dirs, files in os.walk(clip_folder)
                if "session.mpd" in files
            )
            if not session_dirs:
                await decky.emit(
                    "conversion_progress",
                    {"status": "error", "error": "No Steam recording data found in clip folder"},
                )
                return

            temp_videos: list = []
            temp_audios: list = []

            for data_dir in session_dirs:
                init_video = os.path.join(data_dir, "init-stream0.m4s")
                init_audio = os.path.join(data_dir, "init-stream1.m4s")
                if not (os.path.exists(init_video) and os.path.exists(init_audio)):
                    decky.logger.warning(
                        f"Missing init segments in {data_dir}, skipping"
                    )
                    continue

                # Binary-concatenate init segment + chunk segments into one temp mp4
                with tempfile.NamedTemporaryFile(
                    delete=False, suffix=".mp4"
                ) as tmp_v:
                    tmp_v_path = tmp_v.name
                    with open(init_video, "rb") as f:
                        tmp_v.write(f.read())
                    for chunk in sorted(
                        glob.glob(os.path.join(data_dir, "chunk-stream0-*.m4s"))
                    ):
                        with open(chunk, "rb") as f:
                            tmp_v.write(f.read())

                with tempfile.NamedTemporaryFile(
                    delete=False, suffix=".mp4"
                ) as tmp_a:
                    tmp_a_path = tmp_a.name
                    with open(init_audio, "rb") as f:
                        tmp_a.write(f.read())
                    for chunk in sorted(
                        glob.glob(os.path.join(data_dir, "chunk-stream1-*.m4s"))
                    ):
                        with open(chunk, "rb") as f:
                            tmp_a.write(f.read())

                temp_files.extend([tmp_v_path, tmp_a_path])
                temp_videos.append(tmp_v_path)
                temp_audios.append(tmp_a_path)

            if not temp_videos:
                await decky.emit(
                    "conversion_progress",
                    {"status": "error", "error": "Missing m4s init segments in clip"},
                )
                return

            # If multiple recording sessions, concatenate across sessions
            if len(temp_videos) > 1:
                final_video = await self._ffmpeg_concat(temp_videos, is_video=True)
                final_audio = await self._ffmpeg_concat(temp_audios, is_video=False)
                temp_files.extend([final_video, final_audio])
            else:
                final_video = temp_videos[0]
                final_audio = temp_audios[0]

            # Merge video + audio streams into the output mp4
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y",
                "-i", final_video,
                "-i", final_audio,
                "-c", "copy",
                output_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await proc.communicate()
            if proc.returncode == 0:
                await decky.emit(
                    "conversion_progress",
                    {
                        "status": "complete",
                        "output_path": output_path,
                        "size": os.path.getsize(output_path),
                    },
                )
            else:
                err = stderr.decode("utf-8", errors="replace")[-500:]
                await decky.emit(
                    "conversion_progress",
                    {"status": "error", "error": f"ffmpeg error: {err}"},
                )
        except FileNotFoundError:
            await decky.emit(
                "conversion_progress",
                {"status": "error", "error": "ffmpeg not found. Please install ffmpeg."},
            )
        except Exception as exc:
            await decky.emit(
                "conversion_progress", {"status": "error", "error": str(exc)}
            )
        finally:
            for fpath in temp_files:
                try:
                    if os.path.exists(fpath):
                        os.unlink(fpath)
                except OSError:
                    pass

    # ------------------------------------------------------------------
    # Credentials
    # ------------------------------------------------------------------

    async def save_credentials(self, client_id: str, client_secret: str) -> dict:
        """Persist YouTube OAuth2 client credentials to disk."""
        try:
            with open(self._creds_path(), "w") as fh:
                json.dump({"client_id": client_id, "client_secret": client_secret}, fh)
            return {"success": True}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def get_credentials(self) -> dict:
        """Return saved client credentials (empty dict if none saved)."""
        try:
            if os.path.isfile(self._creds_path()):
                with open(self._creds_path()) as fh:
                    return json.load(fh)
        except Exception:
            pass
        return {}

    # ------------------------------------------------------------------
    # YouTube OAuth2 – device-code flow
    # ------------------------------------------------------------------

    async def start_auth(self, client_id: str = "", client_secret: str = "") -> dict:
        """Initiate the YouTube OAuth2 device-code flow.

        *client_id* and *client_secret* are optional — when empty the
        built-in default credentials are used so that end-users don't
        need their own Google Cloud project.

        Returns the *user_code* and *verification_url* that the user must visit.
        """
        try:
            cid = client_id or DEFAULT_CLIENT_ID
            csecret = client_secret or DEFAULT_CLIENT_SECRET
            body = urllib.parse.urlencode(
                {"client_id": cid, "scope": YOUTUBE_SCOPE}
            ).encode()
            req = urllib.request.Request(YOUTUBE_DEVICE_CODE_URL, data=body, method="POST")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                data = json.loads(resp.read())
            self._auth_state = {
                "client_id": cid,
                "client_secret": csecret,
                "device_code": data["device_code"],
                "interval": data.get("interval", 5),
                "expires_in": data.get("expires_in", 1800),
                "started_at": time.time(),
            }
            return {
                "success": True,
                "user_code": data["user_code"],
                "verification_url": data.get("verification_url", "https://google.com/device"),
            }
        except urllib.error.HTTPError as exc:
            return {
                "success": False,
                "error": f"HTTP {exc.code}: {exc.read().decode(errors='replace')[:200]}",
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def poll_auth(self) -> dict:
        """Poll the token endpoint to check whether the user has authorised.

        Call this every *interval* seconds while waiting for the user.
        Returns ``{'authenticated': True}`` on success or
        ``{'pending': True}`` while still waiting.
        """
        if not self._auth_state:
            return {"success": False, "error": "No auth flow in progress"}
        state = self._auth_state
        if time.time() - state["started_at"] > state["expires_in"]:
            self._auth_state = {}
            return {"success": False, "error": "Auth flow expired. Please start again."}
        try:
            body = urllib.parse.urlencode({
                "client_id": state["client_id"],
                "client_secret": state["client_secret"],
                "device_code": state["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            }).encode()
            req = urllib.request.Request(YOUTUBE_TOKEN_URL, data=body, method="POST")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                data = json.loads(resp.read())
            token = {
                "access_token": data["access_token"],
                "refresh_token": data.get("refresh_token", ""),
                "client_id": state["client_id"],
                "client_secret": state["client_secret"],
                "expires_at": time.time() + data.get("expires_in", 3600),
            }
            with open(self._token_path(), "w") as fh:
                json.dump(token, fh)
            self._auth_state = {}
            return {"success": True, "authenticated": True}
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode(errors="replace")
            decky.logger.error(f"[poll_auth] HTTP {exc.code}: {err_body[:200]}")
            try:
                err_data = json.loads(err_body)
                code = err_data.get("error", "")
                if code == "authorization_pending":
                    return {"success": True, "authenticated": False, "pending": True}
                if code == "slow_down":
                    state["interval"] += 5
                    return {"success": True, "authenticated": False, "pending": True}
                if code == "access_denied":
                    self._auth_state = {}
                    return {"success": False, "error": "Access denied by user"}
                if code == "expired_token":
                    self._auth_state = {}
                    return {"success": False, "error": "Auth flow expired"}
            except json.JSONDecodeError:
                pass
            return {"success": False, "error": f"HTTP {exc.code}: {err_body[:200]}"}
        except Exception as exc:
            decky.logger.error(f"[poll_auth] Exception: {exc}")
            return {"success": False, "error": str(exc)}

    async def check_auth(self) -> dict:
        """Return whether the plugin currently holds valid YouTube credentials."""
        if not os.path.isfile(self._token_path()):
            return {"authenticated": False}
        try:
            with open(self._token_path()) as fh:
                token = json.load(fh)
            if time.time() >= token.get("expires_at", 0) - 60:
                if not await self._refresh_token(token):
                    return {"authenticated": False, "needs_reauth": True}
            return {"authenticated": True}
        except Exception as exc:
            return {"authenticated": False, "error": str(exc)}

    async def _refresh_token(self, token: dict) -> bool:
        if not token.get("refresh_token"):
            return False
        try:
            body = urllib.parse.urlencode(
                {
                    "client_id": token["client_id"],
                    "client_secret": token["client_secret"],
                    "refresh_token": token["refresh_token"],
                    "grant_type": "refresh_token",
                }
            ).encode()
            req = urllib.request.Request(YOUTUBE_TOKEN_URL, data=body, method="POST")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                data = json.loads(resp.read())
            token["access_token"] = data["access_token"]
            token["expires_at"] = time.time() + data.get("expires_in", 3600)
            if "refresh_token" in data:
                token["refresh_token"] = data["refresh_token"]
            with open(self._token_path(), "w") as fh:
                json.dump(token, fh)
            return True
        except Exception:
            return False

    async def revoke_auth(self) -> dict:
        """Revoke the stored YouTube token and delete it from disk."""
        if not os.path.isfile(self._token_path()):
            return {"success": True}
        try:
            with open(self._token_path()) as fh:
                token = json.load(fh)
            try:
                revoke_url = (
                    "https://oauth2.googleapis.com/revoke?token="
                    + urllib.parse.quote(token["access_token"])
                )
                urllib.request.urlopen(
                    urllib.request.Request(revoke_url, method="POST"), timeout=10,
                    context=SSL_CTX,
                )
            except Exception:
                pass  # still remove local token on failure
            os.remove(self._token_path())
            return {"success": True}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------
    # YouTube upload (background task + chunked resumable upload)
    # ------------------------------------------------------------------

    async def upload_to_youtube(
        self,
        filepath: str,
        title: str,
        description: str,
        tags: str,
        privacy: str,
    ) -> dict:
        """Start a background YouTube upload task.

        Returns immediately; emits *upload_progress* events while running.
        """
        if not os.path.isfile(filepath):
            return {"success": False, "error": "File not found"}
        asyncio.get_event_loop().create_task(
            self._run_upload(filepath, title, description, tags, privacy)
        )
        return {"success": True, "started": True}

    async def _run_upload(
        self,
        filepath: str,
        title: str,
        description: str,
        tags: str,
        privacy: str,
    ) -> None:
        try:
            await decky.emit("upload_progress", {"progress": 0, "status": "starting"})

            # Load token
            if not os.path.isfile(self._token_path()):
                await decky.emit(
                    "upload_progress",
                    {"status": "error", "error": "Not authenticated with YouTube"},
                )
                return
            with open(self._token_path()) as fh:
                token = json.load(fh)
            if time.time() >= token.get("expires_at", 0) - 60:
                if not await self._refresh_token(token):
                    await decky.emit(
                        "upload_progress",
                        {"status": "error", "error": "Token expired. Please re-authenticate."},
                    )
                    return
                with open(self._token_path()) as fh:
                    token = json.load(fh)

            access_token: str = token["access_token"]
            file_size: int = os.path.getsize(filepath)
            tag_list = (
                [t.strip() for t in tags.split(",") if t.strip()] if tags else []
            )

            # Initiate resumable upload session
            meta = json.dumps(
                {
                    "snippet": {
                        "title": title or os.path.basename(filepath),
                        "description": description or "",
                        "tags": tag_list,
                        "categoryId": "20",  # Gaming
                    },
                    "status": {"privacyStatus": privacy or "private"},
                }
            ).encode("utf-8")

            init_req = urllib.request.Request(
                f"{YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status",
                data=meta,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Type": "video/*",
                    "X-Upload-Content-Length": str(file_size),
                },
                method="POST",
            )
            with urllib.request.urlopen(init_req, timeout=30, context=SSL_CTX) as resp:
                upload_url = resp.headers.get("Location")

            if not upload_url:
                await decky.emit(
                    "upload_progress",
                    {"status": "error", "error": "Failed to obtain upload URL"},
                )
                return

            await decky.emit("upload_progress", {"progress": 0, "status": "uploading"})

            # Upload chunks in a thread so we don't block the event loop
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                self._sync_upload_chunks,
                upload_url,
                filepath,
                access_token,
                file_size,
                loop,
            )
            await decky.emit("upload_progress", result)

        except Exception as exc:
            decky.logger.error(f"Upload failed: {exc}")
            await decky.emit("upload_progress", {"status": "error", "error": str(exc)})

    def _sync_upload_chunks(
        self,
        upload_url: str,
        filepath: str,
        access_token: str,
        file_size: int,
        loop: asyncio.AbstractEventLoop,
    ) -> dict:
        """Upload the file in 8 MB chunks using YouTube's resumable upload protocol.

        Must run in a thread (called via run_in_executor) because it uses
        blocking I/O.  Progress events are posted back to *loop*.
        """
        chunk_size = UPLOAD_CHUNK_SIZE
        bytes_uploaded = 0
        parsed = urllib.parse.urlparse(upload_url)
        path_qs = parsed.path + ("?" + parsed.query if parsed.query else "")

        with open(filepath, "rb") as fh:
            while bytes_uploaded < file_size:
                fh.seek(bytes_uploaded)
                chunk = fh.read(chunk_size)
                if not chunk:
                    break
                chunk_end = bytes_uploaded + len(chunk) - 1
                headers = {
                    "Authorization": f"Bearer {access_token}",
                    "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {bytes_uploaded}-{chunk_end}/{file_size}",
                    "Content-Type": "video/*",
                }
                conn = http.client.HTTPSConnection(parsed.netloc, timeout=300, context=SSL_CTX)
                try:
                    conn.request("PUT", path_qs, body=chunk, headers=headers)
                    resp = conn.getresponse()
                    status = resp.status
                    if status in (200, 201):
                        body = resp.read()
                        video_data = json.loads(body)
                        video_id = video_data.get("id", "")
                        return {
                            "progress": 100,
                            "status": "complete",
                            "video_id": video_id,
                            "video_url": f"https://youtube.com/watch?v={video_id}",
                        }
                    elif status == 308:
                        range_hdr = resp.getheader("Range", "")
                        resp.read()  # consume response body
                        if range_hdr:
                            bytes_uploaded = int(range_hdr.split("-")[1]) + 1
                        else:
                            bytes_uploaded += len(chunk)
                        # Emit progress back on the event loop
                        progress = int(bytes_uploaded / file_size * 100)
                        asyncio.run_coroutine_threadsafe(
                            decky.emit(
                                "upload_progress",
                                {
                                    "progress": progress,
                                    "status": "uploading",
                                    "bytes_uploaded": bytes_uploaded,
                                    "total_bytes": file_size,
                                },
                            ),
                            loop,
                        )
                    else:
                        body = resp.read().decode("utf-8", errors="replace")[:500]
                        return {
                            "status": "error",
                            "error": f"HTTP {status}: {body}",
                        }
                finally:
                    conn.close()

        return {"status": "error", "error": "Upload ended without receiving completion response"}
