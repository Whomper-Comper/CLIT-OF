module.exports = {
  apps: [
    {
      name: "clit-of-bot",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      node_args: "--no-warnings",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
