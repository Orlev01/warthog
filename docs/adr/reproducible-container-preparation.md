# Container preparation and local font assets

Status: implementation, 9 November 2026. No publication or deployment authorized.

The current production build fetches Inter from Google Fonts and fails when build-time DNS/network access is unavailable. Preserve the existing font and all seven subsets by vendoring the exact font files from the prior local build, with their upstream SIL Open Font License and a hash manifest. Serve them from the application's own origin. This removes the font download from future builds and adds no package dependency or external service.

Package the Next standalone server in a Node 22 Debian slim multi-stage container. Build with the lockfile, exclude local secrets/data and git history from the build context, run as the unprivileged node user, and copy static/public assets, migrations and connector catalogue explicitly. Check the staged runtime tree against those requirements before the image's final stage. The release manifest must record the base image digest and built application digest before deployment; a floating development base tag is not immutable release evidence.

Use the existing failed build as the regression check, followed by TypeScript and the runtime-tree validation. Container execution and real PostgreSQL acceptance still require an environment with Docker/network permissions. Do not weaken those gates or claim PGlite is production acceptance.
