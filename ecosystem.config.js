module.exports = {
  apps: [
    {
      name: "gpu-backend",
      script: "./server.js",
      cwd: "/mnt/c/build_gpu/GPU_Render_Service/backend",
      interpreter: "node",
      exec_mode: "fork",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "gpu-worker",
      script: "./render_worker.js",
      cwd: "/mnt/c/build_gpu/GPU_Render_Service/backend",
      interpreter: "node",
      exec_mode: "fork",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
