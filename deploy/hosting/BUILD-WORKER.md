# Web Studio builds on a Debian VPS with PM2

Generated Astro projects execute code. The application therefore refuses to build them until an isolated worker is configured. Static HTML imports do not need this worker.

For this VPS, use Bubblewrap and the aios systemd user manager. Docker is not required. PM2 continues running AI OS as before. The installer checks cgroup v2 and user namespaces; it fails if isolation is unavailable. Do not disable the sandbox to work around a failed check.

After pulling the repair commit into /opt/ai-os, run:

```sh
cd /opt/ai-os
sudo bash deploy/hosting/install-build-worker.sh
sudo -iu aios sh -c 'cd /opt/ai-os && node tools/verify-build-worker.js'
```

The installer installs Debian's bubblewrap and util-linux packages, installs the fixed Astro runtime in root-owned /opt/aios-build-runtime, and enables the persistent user manager for aios. Node 24 must be installed at /usr/bin/node. It preserves the runtime's generated lockfile for subsequent reproducible installs. No tenant dependencies or package scripts are installed.

Only after verification passes, add this to /opt/ai-os/.env:

```dotenv
AIOS_BUILD_BACKEND=bubblewrap
```

Restart the application:

```sh
sudo -iu aios pm2 restart ai-os --update-env
```

Each build receives staged source and read-only runtime dependencies. Bubblewrap hides the application's files, credentials and host network. A transient systemd service limits memory to 768 MB, disables swap, limits processes to 128, limits CPU to one core and stops the whole process group at the deadline. Artifacts are validated before publication. A failed worker never falls back to unrestricted execution. See [Bubblewrap's isolation model](https://github.com/containers/bubblewrap).

The verification command builds a real Astro page and checks that the build cannot read a host canary, the application's environment, or connect to an external address. Run it as aios, never root. A Windows unit test cannot establish that the VPS supports these controls. Confirm cgroup limits and test a generated site, first HTTPS publication and republication on the VPS before treating deployment as complete.

## Other deployment requirements

Configure STRIPE_WEBHOOK_SECRET, an HTTPS AIOS_PUBLIC_URL (or AIOS_PRIMARY_DOMAIN), and Email settings (Resend or SMTP, plus a From address). Managed checkout stays unavailable until these settings exist. Use Stripe test mode to verify payment, invitation email, password setup and login. A health response alone does not verify these workflows. Invitations retry persistently; repeated delivery failures appear in billing activity. Existing clients with a password continue signing in normally.

Install the updated root-owned site-vhost.sh alongside the application, because publication uses its --preserve-existing option. To update only the microphone policy in the existing live nginx configuration, preserving local domain/TLS settings:

```sh
sudo node /opt/ai-os/tools/update-nginx-microphone.js --apply
```

This saves a backup, changes only recognized microphone directives, runs nginx -t, reloads nginx, and restores the prior file if validation or reload fails. Inspect the Permissions-Policy response header on /app and test microphone access over HTTPS. The tool stops for an unfamiliar configuration instead of replacing the whole vhost.

Docker remains an optional existing backend when AIOS_BUILD_IMAGE is configured and AIOS_BUILD_BACKEND is not bubblewrap; it is not part of this VPS procedure.
