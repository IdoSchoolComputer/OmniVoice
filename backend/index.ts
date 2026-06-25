import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";
import { spawn } from "child_process";

const require = createRequire(import.meta.url);
const multer = require("multer");

function renderProgress(current: number, total: number, message: string) {
  const width = 28;
  const normalized = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0;
  const filled = Math.round(normalized * width);
  const empty = width - filled;
  const percent = total > 0 ? Math.round(normalized * 100) : 0;
  const bar = `${"█".repeat(filled)}${"─".repeat(empty)}`;
  const text = `[SYNTH] ${current}/${total} ${bar} ${percent}% - ${message}`;
  process.stdout.write(`\r${text.padEnd(120)}`);
}

function clearProgress() {
  process.stdout.write(`\r${" ".repeat(120)}\r`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  // Ensure tmp directory exists
  const tmpDir = path.resolve(__dirname, "..", "tmp");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log(`Created tmp directory: ${tmpDir}`);
  }

  // Add request logging middleware
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  // Add JSON and URL-encoded body parsing middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  app.use(express.static(staticPath));
  app.use("/tmp", express.static(tmpDir, {
    setHeaders: (_res, _filePath) => {
      _res.setHeader("Content-Type", "audio/wav");
    },
  }));

  // API: POST /api/synthesize
  // Accepts multipart form: ref_audio (file, optional), texts (array of strings), output_name (string)
  const upload = multer({ dest: tmpDir });

  app.post(
    "/api/synthesize",
    upload.single("ref_audio"),
    async (req, res) => {
      try {
        console.log("[/api/synthesize] POST request received");
        console.log("[/api/synthesize] Body:", req.body);
        console.log("[/api/synthesize] File:", req.file);
        
        const textsRaw = req.body.texts;
        let texts: string[] = [];
        if (Array.isArray(textsRaw)) {
          texts = textsRaw.filter(Boolean);
        } else if (typeof textsRaw === "string") {
          // single text or newline-separated
          texts = textsRaw.split("\n").map((s) => s.trim()).filter(Boolean);
        }

        if (!texts.length) {
          return res.status(400).json({ error: "No texts provided" });
        }

        const language = typeof req.body.language === 'string' ? req.body.language : undefined;
        const refText = typeof req.body.ref_text === 'string' ? req.body.ref_text : undefined;
        const refAudioPath = req.file ? req.file.path : null;
        const repoRoot = path.resolve(__dirname, "..");
        const downloadId = `synth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const outDir = path.resolve(repoRoot, "tmp", downloadId);
        fs.mkdirSync(outDir, { recursive: true });

        // Build command to call the Python CLI infer.py for each sentence
        // Use the repo's omnivoice CLI script
        // Use venv Python if available, otherwise fall back to system python
        const venvPython = path.join(repoRoot, ".venv", "Scripts", "python.exe");
        const python = fs.existsSync(venvPython)
          ? venvPython
          : process.env.PYTHON || "python";
        const scriptPath = path.join(repoRoot, "omnivoice", "cli", "infer.py");
        const modelArg = process.env.OMNIVOICE_MODEL || "k2-fsa/OmniVoice";
        const outputFiles: Array<{ name: string; url: string }> = [];

        for (let i = 0; i < texts.length; i++) {
          const t = texts[i];
          const sentenceNumber = i + 1;
          const fileName = `out_${String(sentenceNumber).padStart(3, "0")}.wav`;
          const outPath = path.join(outDir, fileName);
          const args = [
            scriptPath,
            "--model",
            modelArg,
            "--text",
            t,
            "--output",
            outPath,
          ];
          if (refAudioPath) {
            args.push("--ref_audio", refAudioPath);
          }
          if (refText) {
            args.push("--ref_text", refText);
          }
          if (language) {
            args.push("--language", language);
          }

          console.log(`\n[/api/synthesize] Running sentence ${sentenceNumber}/${texts.length}`);
          console.log(`[/api/synthesize] Command: ${python} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
          renderProgress(sentenceNumber - 1, texts.length, "starting infer.py");

          await new Promise<void>((resolve, reject) => {
            const p = spawn(python, args, {
              cwd: repoRoot,
              env: {
                ...process.env,
                PYTHONPATH: repoRoot,
                HF_HUB_DISABLE_SYMLINKS: "1",
                HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });

            let stdout = "";
            let stderr = "";

            p.stdout?.on("data", (chunk) => {
              const text = String(chunk);
              stdout += text;
              process.stdout.write(`\n[infer ${sentenceNumber} STDOUT] ${text}`);
            });
            p.stderr?.on("data", (chunk) => {
              const text = String(chunk);
              stderr += text;
              process.stdout.write(`\n[infer ${sentenceNumber} STDERR] ${text}`);
            });

            p.on("close", (code) => {
              if (code === 0) {
                renderProgress(sentenceNumber, texts.length, "completed");
                clearProgress();
                outputFiles.push({
                  name: fileName,
                  url: `/tmp/${downloadId}/${fileName}`,
                });
                console.log(`[/api/synthesize] Completed sentence ${sentenceNumber}/${texts.length}`);
                return resolve();
              }
              clearProgress();
              reject(new Error(`infer.py exit ${code}\n${stdout}${stderr ? "\n" + stderr : ""}`));
            });
            p.on("error", (err) => {
              clearProgress();
              reject(err);
            });
          });
        }

        res.json({
          files: outputFiles,
        });

        // cleanup ref audio after response
        if (refAudioPath) {
          try {
            fs.unlinkSync(refAudioPath);
          } catch {}
        }
      } catch (err: any) {
        console.error("[/api/synthesize] ERROR:", err);
        const errorMsg = err?.message || String(err);
        const errorDetails = err?.stack || String(err);
        console.error("[/api/synthesize] Error details:", errorDetails);
        res.status(500).json({
          error: errorMsg,
          details: errorDetails,
        });
      }
    }
  );

  // Handle client-side routing - serve index.html for all other GET routes (SPA fallback)
  app.get("*", (_req, res) => {
    console.log(`[SPA Fallback] Serving index.html for ${_req.path}`);
    res.sendFile(path.join(staticPath, "index.html"));
  });

  // Handle 404 for any unmatched POST/PUT/DELETE routes
  app.use((req, res) => {
    console.log(`[404] ${req.method} ${req.path} - route not found`);
    res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
  });

  const port = process.env.PORT || (process.env.NODE_ENV === "production" ? 3000 : 3001);

  server.listen(port, () => {
    console.log(`[${new Date().toISOString()}] Server running on http://localhost:${port}/`);
    console.log(`Static path: ${staticPath}`);
    console.log(`Tmp directory: ${tmpDir}`);
  });
}

startServer().catch(console.error);
