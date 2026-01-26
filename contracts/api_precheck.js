const precheckBlender = require("../worker/precheck_blender");
const enhancePrecheck = require("./precheck_enhancer");

module.exports = async function apiPrecheck(req, res) {
    try {
        const { file_path } = req.body || {};

        // Kontroll: vi kräver endast file_path nu
        if (!file_path) {
            return res.status(400).json({
                error: "BAD_REQUEST",
                required: ["file_path"]
            });
        }

        // 1. Kör Blender raw precheck via bridge (WSL -> Windows)
        const raw = await precheckBlender(file_path);

        // 2. Kör Phase-1.2 enhancer
        const enhanced = await enhancePrecheck({
            frames: raw.frames,
            res_x: raw.x,
            res_y: raw.y,
            samples: raw.samples
        });

        return res.json({
            status: "OK",
            raw,
            enhanced
        });

    } catch (err) {
        console.error("[contracts/api_precheck]", err);
        return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
};
