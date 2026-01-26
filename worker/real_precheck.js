const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const precheckBlender = require("./precheck_blender");

const BLENDER_EXE = "/mnt/c/Program Files/Blender Foundation/Blender 5.0/blender.exe";

// Converts /mnt/c/... to C:\...
function wslToWindowsPath(p) {
  return p
    .replace(/^\/mnt\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, "\\");
}

// Executes a single blender frame render in Windows
// Executes a single blender frame render in Windows
async function execBlenderFrame(winBlendPath, frameIndex, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const tmpDir = "/mnt/c/gpu_render_service/tmp_real";
    fs.mkdirSync(tmpDir, { recursive: true });

    const outputBase = path.join(tmpDir, `real_${process.pid}_${frameIndex}_#####`);
    const winOutputBase = wslToWindowsPath(outputBase);

    const startTime = process.hrtime.bigint();

    let collectedStdout = "";
    let collectedStderr = "";

    const blender = execFile(
      BLENDER_EXE,
      [
        "-b",
        winBlendPath,
        "--factory-startup",
        "-E", "CYCLES",
        "-o", winOutputBase,
        "-f", String(frameIndex)
      ],
      { windowsHide: true },
      (err) => {
        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1e6;

        if (err) {
          const lowerErr = (collectedStderr + collectedStdout).toLowerCase();

          if (lowerErr.includes("no camera")) {
            return reject(new Error("SCENE_NO_CAMERA"));
          }

          return reject(new Error("REAL_PRECHECK_RENDER_FAILED"));
        }

        resolve(durationMs);
      }
    );

    blender.stdout.on("data", chunk => {
      collectedStdout += chunk.toString();
    });

    blender.stderr.on("data", chunk => {
      collectedStderr += chunk.toString();
    });

    const killTimer = setTimeout(() => {
      blender.kill("SIGKILL");
      reject(new Error("REAL_PRECHECK_TIMEOUT"));
    }, timeoutMs);

    blender.on("close", () => clearTimeout(killTimer));
  });
}

function chooseTestFrames(totalFrames, maxSamples = 3) {
  if (totalFrames <= maxSamples) {
    const frames = [];
    for (let i = 1; i <= totalFrames; i++) frames.push(i);
    return frames;
  }
  return [1, Math.floor(totalFrames / 2), totalFrames];
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

module.exports = async function realPrecheck(blendPath, opts = {}) {
  if (!fs.existsSync(blendPath)) {
    throw new Error("BLEND_FILE_NOT_FOUND");
  }

  const { maxSamples = 3, timeoutMs = 300000 } = opts;

  // Detect synthetic mode (filnamn innehåller "test")
  const synthetic = blendPath.toLowerCase().includes("test");

  // Get basic scene info
  const raw = await precheckBlender(blendPath);
  const framesTotal = Number(raw.frames || 1);

  // Choose test frames
  const testFrames = chooseTestFrames(framesTotal, maxSamples);

  const timings = [];

  let winBlendPath = null;

  if (!synthetic) {
    // Normal mode: require valid Windows path
    const converted = wslToWindowsPath(blendPath);
    if (/^[A-Z]:\\/.test(converted)) {
      winBlendPath = converted;
    } else {
      throw new Error("INVALID_WINDOWS_PATH blendPath=" + blendPath);
    }
  }

  for (const f of testFrames) {
    if (synthetic) {
      timings.push(10000); // fake 10s per frame
    } else {
      const ms = await execBlenderFrame(winBlendPath, f, timeoutMs);
      timings.push(ms);
    }
  }

  const medianMs = percentile(timings, 50);
  const p90Ms = percentile(timings, 90);

  let estimatedHours = (framesTotal * medianMs) / (1000 * 3600);

  // Apply synthetic overflow boost
  if (synthetic) {
    console.log("[E2E] synthetic overflow enabled");
    estimatedHours = estimatedHours * 12.0;
    console.log("[E2E] estimated synthetic hours =", estimatedHours.toFixed(2));
  }

  return {
    raw: {
      frames: framesTotal,
      res_x: raw.x,
      res_y: raw.y,
      samples: raw.samples
    },
    real: {
      frames_total: framesTotal,
      tested_frames: testFrames,
      timings_ms: timings,
      median_ms_per_frame: medianMs,
      p90_ms_per_frame: p90Ms,
      estimated_hours_real: Number(estimatedHours.toFixed(2))
    }
  };
};
