const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- CONFIG ---
const BLENDER_EXE =
  "/mnt/c/Program Files/Blender Foundation/Blender 5.0/blender.exe";

function wslToWindowsPath(p) {
  return p
    .replace(/^\/mnt\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, "\\");
}

module.exports = function precheckBlender(blendPath) {
  return new Promise((resolve, reject) => {

    if (!fs.existsSync(blendPath)) {
      return reject(new Error("BLEND_FILE_NOT_FOUND"));
    }

    // ABSOLUT WINDOWS-DELAD TMP
    const tmpDir = "/mnt/c/gpu_render_service/tmp";
    fs.mkdirSync(tmpDir, { recursive: true });

    const tmpScript = path.join(
      tmpDir,
      `blender_precheck_${process.pid}_${Date.now()}.py`
    );

    const python = `
import bpy
scene = bpy.context.scene

frames = scene.frame_end - scene.frame_start + 1
res_x = scene.render.resolution_x
res_y = scene.render.resolution_y
samples = scene.cycles.samples

print(f"{frames},{res_x},{res_y},{samples}")
`;

    fs.writeFileSync(tmpScript, python);

    const winBlend = wslToWindowsPath(blendPath);
    const winScript = wslToWindowsPath(tmpScript);

console.log("[BLENDER CMD]", BLENDER_EXE);
console.log("[BLENDER ARG]", winBlend);
console.log("[BLENDER ARG]", winScript);

if (!/^[A-Z]:\\/.test(winBlend)) {
  throw new Error("INVALID_WINDOWS_PATH winBlend=" + winBlend);
}

if (!/^[A-Z]:\\/.test(winScript)) {
  throw new Error("INVALID_WINDOWS_PATH winScript=" + winScript);
}

    execFile(
      BLENDER_EXE,
      ["-b", winBlend, "--factory-startup", "--python", winScript],
      { timeout: 30000, windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpScript); } catch {}

        if (err) {
          return reject(
            new Error(
              "BLENDER_PRECHECK_FAILED: " +
              (stderr?.trim() || err.message)
            )
          );
        }

        // --- ROBUST PARSING ---
        const match = stdout.match(/(\d+),(\d+),(\d+),(\d+)/);
        if (!match) {
          return reject(new Error("PRECHECK_OUTPUT_PARSE_ERROR"));
        }

        const frames  = Number(match[1]);
        const x       = Number(match[2]);
        const y       = Number(match[3]);
        const samples = Number(match[4]);

        resolve({ frames, x, y, samples });
      }
    );
  });
};
