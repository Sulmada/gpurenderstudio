import bpy
import time
import json

scene = bpy.context.scene

frames_total = scene.frame_end - scene.frame_start + 1

tested_frames = []
timings = []

frames_to_test = list(range(scene.frame_start, min(scene.frame_start + 3, scene.frame_end + 1)))

for f in frames_to_test:
    scene.frame_set(f)
    t0 = time.time()
    bpy.ops.render.render(write_still=False)
    dt = (time.time() - t0) * 1000.0
    tested_frames.append(f)
    timings.append(dt)

if timings:
    timings_sorted = sorted(timings)
    n = len(timings_sorted)
    median = timings_sorted[n // 2]
    p90 = timings_sorted[int(0.9 * (n - 1))]
else:
    median = 0
    p90 = 0

if median > 0:
    estimated_seconds_total = median * frames_total / 1000.0
    estimated_hours_real = estimated_seconds_total / 3600.0
else:
    estimated_hours_real = 0

result = {
    "status": "OK",
    "frames_total": frames_total,
    "tested_frames": tested_frames,
    "timings_ms": timings,
    "median_ms_per_frame": median,
    "p90_ms_per_frame": p90,
    "estimated_hours_real": estimated_hours_real
}

print(json.dumps(result))
