"use strict";

const { spawn } = require("child_process");
const path = require("path");

const BLENDER = "blender";

const VALIDATOR_SCRIPT = path.join(__dirname, "..", "contracts", "scene_validate.py");
const TIMING_SCRIPT    = path.join(__dirname, "..", "contracts", "timing_precheck.py");

function runBlender(blendPath, scriptPath, timeoutMs) {
  return new Promise((resolve, reject) => {

    console.log("[DEBUG] blendPath =", blendPath);
    console.log("[DEBUG] scriptPath =", scriptPath);

    const args = [
      "-b",
      blendPath,
      "--python", scriptPath
    ];

    const proc = spawn(BLENDER, args, { shell: false });

    let stdoutBuf = "";
    let stderrBuf = "";
    let finished = false;

    const timeoutHandle = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill("SIGKILL");

      return resolve({
        status: "ERROR",
        fail_class: "VALIDATOR_TIMEOUT",
        reason: "Blender validator exceeded timeout",
        stdout: stdoutBuf,
        stderr: stderrBuf
      });
    }, timeoutMs);

    proc.stdout.on("data", d => {
      const s = d.toString();
      stdoutBuf += s;
      console.log("[VALIDATE STDOUT]", s);
    });

    proc.stderr.on("data", d => {
      const s = d.toString();
      stderrBuf += s;
      console.log("[VALIDATE STDERR]", s);
    });

    proc.on("error", err => {
      clearTimeout(timeoutHandle);
      if (finished) return;
      finished = true;

      return resolve({
        status: "ERROR",
        fail_class: "BLENDER_START_FAILED",
        reason: String(err),
        stdout: stdoutBuf,
        stderr: stderrBuf
      });
    });

    proc.on("close", code => {
      clearTimeout(timeoutHandle);
      if (finished) return;
      finished = true;

      // Blender exit utan code 0 = tolkas som crash
      if (code !== 0) {
        return resolve({
          status: "ERROR",
          fail_class: "BLENDER_CRASH",
          reason: `Blender exit code ${code}`,
          stdout: stdoutBuf,
          stderr: stderrBuf
        });
      }

      // Försök extrahera ALLA JSON-block i stdout (säkert med regex global)
      const matches = stdoutBuf.match(/\{[\s\S]*?\}/g);

      if (!matches || matches.length === 0) {
        return resolve({
          status: "ERROR",
          fail_class: "INVALID_JSON",
          reason: "No JSON found in validator output",
          stdout: stdoutBuf,
          stderr: stderrBuf
        });
      }

      // Ta sista JSON-blocket (Blender kan skriva logs före/efter)
      const last = matches[matches.length - 1];

      try {
        const parsed = JSON.parse(last);
        return resolve({
          status: parsed.status || "OK",
          engine: parsed.engine,
          camera: parsed.camera,
          lights: parsed.lights,
          details: parsed.details || null,
          raw: parsed,
          stdout: stdoutBuf,
          stderr: stderrBuf
        });
      } catch (err) {
        return resolve({
          status: "ERROR",
          fail_class: "INVALID_JSON",
          reason: "Failed to parse JSON",
          stdout: stdoutBuf,
          stderr: stderrBuf
        });
      }
    });
  });
}

async function spawnBlenderValidate(blendPath, timeoutMs = 30000) {
  return await runBlender(blendPath, VALIDATOR_SCRIPT, timeoutMs);
}

async function spawnBlenderTiming(blendPath, timeoutMs = 180000) {
  return await runBlender(blendPath, TIMING_SCRIPT, timeoutMs);
}

module.exports = {
  spawnBlenderValidate,
  spawnBlenderTiming
};
