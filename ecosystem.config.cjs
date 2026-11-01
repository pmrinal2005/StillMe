module.exports = {
  apps: [
    {
      name: 'revoice',
      script: 'npm',
      args: 'run start',
      env: { NODE_ENV: 'production', PORT: 3000 },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
  ],
}
