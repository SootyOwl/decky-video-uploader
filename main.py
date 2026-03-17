import os
import asyncio
import json
import time
import http.client
import urllib.request
import urllib.parse
import urllib.error

import decky

# ---------------------------------------------------------------------------
# YouTube API constants
# ---------------------------------------------------------------------------
YOUTUBE_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code"
YOUTUBE_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload"

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
        os.makedirs(self._converted_dir(), exist_ok=True)

    async def _unload(self):
        decky.logger.info("Video Uploader plugin unloaded")

    async def _uninstall(self):
        pass

    async def _migration(self):
        pass

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _converted_dir(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "converted")

    def _creds_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "client_credentials.json")

    def _token_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "youtube_token.json")

    # ------------------------------------------------------------------
    # Video discovery
    # ------------------------------------------------------------------

    async def get_video_files(self) -> list:
        """Return a list of video files found in Steam / user video directories."""
        user_home = decky.DECKY_USER_HOME
        search_roots: list = [os.path.join(user_home, "Videos")]

        for steam_base in [
            os.path.join(user_home, ".local", "share", "Steam", "userdata"),
            os.path.join(user_home, ".steam", "steam", "userdata"),
        ]:
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
                            videos.append(
                                {
                                    "path": fpath,
                                    "name": fname,
                                    "size": st.st_size,
                                    "modified": st.st_mtime,
                                    "ext": ext,
                                    "needs_conversion": ext != ".mp4",
                                }
                            )
                        except OSError:
                            pass
            except PermissionError:
                pass

        videos.sort(key=lambda v: v["modified"], reverse=True)
        return videos

    # ------------------------------------------------------------------
    # MP4 conversion (runs as a background asyncio task)
    # ------------------------------------------------------------------

    async def convert_to_mp4(self, source_path: str) -> dict:
        """Convert a video to H.264/AAC MP4 using ffmpeg.

        Returns immediately; emits *conversion_progress* events when done.
        """
        if not os.path.isfile(source_path):
            return {"success": False, "error": "Source file not found"}
        asyncio.get_event_loop().create_task(self._run_conversion(source_path))
        return {"success": True, "started": True}

    async def _run_conversion(self, source_path: str) -> None:
        os.makedirs(self._converted_dir(), exist_ok=True)
        base = os.path.splitext(os.path.basename(source_path))[0]
        output_path = os.path.join(self._converted_dir(), f"{base}.mp4")
        counter = 1
        while os.path.exists(output_path):
            output_path = os.path.join(self._converted_dir(), f"{base}_{counter}.mp4")
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

    async def start_auth(self, client_id: str, client_secret: str) -> dict:
        """Initiate the YouTube OAuth2 device-code flow.

        Returns the *user_code* and *verification_url* that the user must visit.
        """
        try:
            body = urllib.parse.urlencode(
                {"client_id": client_id, "scope": YOUTUBE_SCOPE}
            ).encode()
            req = urllib.request.Request(YOUTUBE_DEVICE_CODE_URL, data=body, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            self._auth_state = {
                "client_id": client_id,
                "client_secret": client_secret,
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
            body = urllib.parse.urlencode(
                {
                    "client_id": state["client_id"],
                    "client_secret": state["client_secret"],
                    "device_code": state["device_code"],
                    "grant_type": "urn:ietf:params:oauth2:grant-type:device_code",
                }
            ).encode()
            req = urllib.request.Request(YOUTUBE_TOKEN_URL, data=body, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
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
            with urllib.request.urlopen(req, timeout=30) as resp:
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
                    urllib.request.Request(revoke_url, method="POST"), timeout=10
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
            with urllib.request.urlopen(init_req, timeout=30) as resp:
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
                conn = http.client.HTTPSConnection(parsed.netloc, timeout=300)
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
