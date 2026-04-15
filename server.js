const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { create: createYtDlp } = require("yt-dlp-exec");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ─── DOWNLOAD LATEST yt-dlp TO /tmp ──────────────────────────────────────────
// Render node_modules is read-only — can't update in place.
// Download fresh binary to writable /tmp on every cold start.
// This ensures we always have the latest yt-dlp (YouTube breaks old versions).

const YTDLP_BIN = path.join(os.tmpdir(), "yt-dlp");
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

async function downloadYtDlp() {
  return new Promise((resolve, reject) => {
    console.log("[yt-dlp] downloading latest binary...");
    const file = fs.createWriteStream(YTDLP_BIN);

    const follow = (url) => {
      https.get(url, (res) => {
        // Follow redirects (GitHub releases redirect)
        if (res.statusCode === 301 || res.statusCode === 302) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          fs.chmodSync(YTDLP_BIN, "755");
          console.log("[yt-dlp] binary ready at", YTDLP_BIN);
          resolve();
        });
      }).on("error", reject);
    };

    follow(YTDLP_URL);
  });
}

// ytDlp instance using the fresh binary — set after download
let ytDlp;

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_DURATION_SECONDS = 30 * 60; // 30 minutes hard limit

// ─── CORS ────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS env var = comma-separated list, e.g.
//   https://iaudiobook.vercel.app,https://iaudiobook.com
// Defaults to localhost for local dev.
const rawOrigins = process.env.ALLOWED_ORIGINS || "http://localhost:3000";
const allowedOrigins = rawOrigins.split(",").map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
// 10 requests per minute per IP — prevents abuse
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
});
app.use("/api", limiter);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function isValidYouTubeVideoId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function buildYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function getTmpPath(videoId) {
  // Use OS temp dir — writable on all platforms including Render
  return path.join(os.tmpdir(), `audiobook_${videoId}_${Date.now()}.mp3`);
}

function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error("Cleanup error:", err.message);
    });
  }
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
// UptimeRobot pings this every 5 minutes to keep Render awake
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "audiobook-downloader",
  });
});

// ─── VIDEO INFO ──────────────────────────────────────────────────────────────
// POST /api/video-info
// Body: { videoId: string }
// Returns: { title, thumbnail, durationSeconds, channel, available }
// Errors: 400 if video too long, private, or unavailable
app.post("/api/video-info", async (req, res) => {
  const { videoId } = req.body;

  if (!videoId || !isValidYouTubeVideoId(videoId)) {
    return res.status(400).json({ error: "Invalid or missing videoId" });
  }

  const url = buildYouTubeUrl(videoId);

  try {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      skipDownload: true,
      // Don't need video formats — audio only
      format: "bestaudio/best",
    });

    const durationSeconds = info.duration || 0;

    // Server-side duration guard — same rule as client
    if (durationSeconds > MAX_DURATION_SECONDS) {
      return res.status(400).json({
        error: `Video is ${Math.floor(durationSeconds / 60)} minutes long. Maximum allowed is 30 minutes.`,
        code: "DURATION_EXCEEDED",
        durationSeconds,
      });
    }

    return res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      durationSeconds,
      channel: info.uploader || info.channel || "Unknown",
      available: true,
    });
  } catch (err) {
    console.error("[video-info] error:", err.message);

    if (/private video/i.test(err.message)) {
      return res.status(400).json({ error: "This video is private.", code: "PRIVATE" });
    }
    if (/not available/i.test(err.message) || /unavailable/i.test(err.message)) {
      return res.status(400).json({ error: "Video is unavailable.", code: "UNAVAILABLE" });
    }
    if (/copyright/i.test(err.message)) {
      return res.status(400).json({ error: "Video blocked due to copyright.", code: "COPYRIGHT" });
    }
    if (/sign in/i.test(err.message) || /login/i.test(err.message)) {
      return res.status(400).json({ error: "Video requires sign-in.", code: "LOGIN_REQUIRED" });
    }
    if (/confirm your age/i.test(err.message) || /age.restrict/i.test(err.message)) {
      return res.status(400).json({ error: "Age-restricted video.", code: "AGE_RESTRICTED" });
    }

    // Always include yt-dlp detail so we can diagnose from response
    return res.status(500).json({
      error: "Failed to fetch video info. Please try again.",
      detail: err.message,
    });
  }
});

// ─── DOWNLOAD AUDIO ──────────────────────────────────────────────────────────
// POST /api/download-audio
// Body: { videoId: string }
// Returns: audio/mpeg stream
app.post("/api/download-audio", async (req, res) => {
  const { videoId } = req.body;

  if (!videoId || !isValidYouTubeVideoId(videoId)) {
    return res.status(400).json({ error: "Invalid or missing videoId" });
  }

  const url = buildYouTubeUrl(videoId);
  const tmpFile = getTmpPath(videoId);

  // Track whether headers already sent so we don't double-respond
  let headersSent = false;

  try {
    // ── Step 1: Fetch metadata to validate duration ──────────────────────────
    let durationSeconds = 0;
    try {
      const info = await ytDlp(url, {
        dumpSingleJson: true,
        noWarnings: true,
        skipDownload: true,
      });
      durationSeconds = info.duration || 0;
    } catch (infoErr) {
      console.error("[download-audio] info fetch failed:", infoErr.message);
      // Continue — let the actual download attempt fail with a better error
    }

    if (durationSeconds > MAX_DURATION_SECONDS) {
      return res.status(400).json({
        error: `Video too long (${Math.floor(durationSeconds / 60)} min). Max 30 minutes.`,
        code: "DURATION_EXCEEDED",
      });
    }

    // ── Step 2: Download audio only ──────────────────────────────────────────
    await ytDlp(url, {
      extractAudio: true,
      audioFormat: "mp3",
      // Quality 5 = ~128kbps — good balance of quality vs file size
      audioQuality: "5",
      output: tmpFile,
      noWarnings: true,
      noCallHome: true,
      // Prefer free formats, no DRM
      preferFreeFormats: true,
    });

    // Verify file was actually created
    if (!fs.existsSync(tmpFile)) {
      throw new Error("Download completed but output file not found");
    }

    const stat = fs.statSync(tmpFile);
    const fileSize = stat.size;

    if (fileSize === 0) {
      cleanupFile(tmpFile);
      throw new Error("Downloaded file is empty");
    }

    // ── Step 3: Stream to client ─────────────────────────────────────────────
    headersSent = true;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", fileSize);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${videoId}.mp3"`
    );
    // Allow client to know file size for progress tracking
    res.setHeader("X-File-Size", fileSize.toString());

    const readStream = fs.createReadStream(tmpFile);

    readStream.on("error", (streamErr) => {
      console.error("[download-audio] stream error:", streamErr.message);
      cleanupFile(tmpFile);
      // Can't send JSON now — headers already sent
      res.end();
    });

    readStream.on("close", () => {
      cleanupFile(tmpFile);
    });

    readStream.pipe(res);
  } catch (err) {
    cleanupFile(tmpFile);
    console.error("[download-audio] error:", err.message);

    if (headersSent) {
      res.end();
      return;
    }

    if (/private video/i.test(err.message)) {
      return res.status(400).json({ error: "This video is private.", code: "PRIVATE" });
    }
    if (/not available/i.test(err.message) || /unavailable/i.test(err.message)) {
      return res.status(400).json({ error: "Video unavailable for download.", code: "UNAVAILABLE" });
    }
    if (/copyright/i.test(err.message)) {
      return res.status(400).json({ error: "Video blocked due to copyright.", code: "COPYRIGHT" });
    }

    return res.status(500).json({ error: "Download failed. Please try again." });
  }
});

// ─── 404 CATCH-ALL ───────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── START ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await downloadYtDlp();
  } catch (e) {
    // Download failed — fall back to bundled binary from yt-dlp-exec
    console.warn("[yt-dlp] fresh download failed, using bundled binary:", e.message);
    const pkgRoot = path.dirname(require.resolve("yt-dlp-exec/package.json"));
    const bundled = path.join(pkgRoot, "bin", "yt-dlp");
    Object.assign(module.exports, { YTDLP_BIN: bundled });
  }

  // Create ytDlp instance pointing to the binary we just downloaded
  ytDlp = createYtDlp(YTDLP_BIN);

  app.listen(PORT, () => {
    console.log(`audiobook-downloader running on port ${PORT}`);
    console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
  });
})();
