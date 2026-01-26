"use strict";

const { spawn } = require("child_process");
const path = require("path");

async function validateScene(blendPath) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, "..", "scripts", "scene_validate.py");

        const blender = spawn("blender", [
            "--background",
            blendPath,
            "--python", scriptPath
        ], {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"] // fånga stdout
        });

        let out = "";
        blender.stdout.on("data", d => out += d.toString());
        blender.stderr.on("data", () => {}); // vi ignorerar stderr just nu

        blender.on("close", code => {
            try {
                const parsed = JSON.parse(out.trim());
                resolve(parsed);
            } catch (e) {
                resolve({
                    status: "ERROR",
                    code: "INVALID_JSON",
                    message: "Validator did not return valid JSON"
                });
            }
        });
    });
}

module.exports = { validateScene };
