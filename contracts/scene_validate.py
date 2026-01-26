import bpy
import json
import sys

def fail(code, message):
    out = {
        "status": "ERROR",
        "code": code,
        "message": message
    }
    print(json.dumps(out))
    sys.exit(0)

# Om argv är förvirrande i Blender så plockar vi .blend via sys.argv
blend_file = None
for i, arg in enumerate(sys.argv):
    if arg.endswith(".blend"):
        blend_file = arg
        break

if not blend_file:
    fail("NO_BLEND", "No blend file provided to validator")

# Försök ladda filen
try:
    bpy.ops.wm.open_mainfile(filepath=blend_file)
except Exception as e:
    fail("LOAD_FAILED", f"Could not load blend: {str(e)}")

scene = bpy.context.scene

# Kamera
if scene.camera is None:
    fail("NO_CAMERA", "No active camera in scene")

# Render engine (Policy A: Cycles Only)
engine = scene.render.engine
if engine != "CYCLES":
    fail("UNSUPPORTED_ENGINE", f"Engine '{engine}' not supported (Cycles required)")

# Här kan vi lägga stricter regler för Phase 1.3
# Men vi börjar minimum. Cycles är vårt fokus.
# Om du vill hårda Cycles-only direkt:
# if engine != "CYCLES":
#     fail("UNSUPPORTED_ENGINE", f"Engine '{engine}' is not Cycles")

# Lyckad validering
out = {
    "status": "OK",
    "engine": engine,
    "camera": True
}
print(json.dumps(out))
