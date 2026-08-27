#!/bin/bash

#=================================================
# COMMON VARIABLES AND CUSTOM HELPERS
#=================================================

nodejs_version=22

# Files and directories excluded when the repo is copied into install_dir.
readonly RSYNC_EXCLUDES=(
    --exclude='.git'
    --exclude='.github'
    --exclude='.gitignore'
    --exclude='.gitattributes'
    --exclude='scripts'
    --exclude='conf'
    --exclude='doc'
    --exclude='tests'
    --exclude='manifest.toml'
    --exclude='config_panel.toml'
    --exclude='node_modules'
    --exclude='server/node_modules'
    --exclude='dist'
    --exclude='server/dist'
    --exclude='server/.devdata'
    --exclude='ios'
)

# Copy the packaged sources into $install_dir.
cloud_sync_sources() {
    rsync -a --delete "${RSYNC_EXCLUDES[@]}" \
        "$YNH_APP_BASEDIR/" "$install_dir/"
}

# Vite's `base` — the sub-path the SPA is served under, with exactly one
# trailing slash. At the root of a domain $path is "/", and the obvious
# "$path/" would produce "//": the browser reads that as protocol-relative and
# goes looking for a host literally called "assets".
cloud_base_path() {
    echo "${path%/}/"
}

# Build the SPA and the API. Both are TypeScript; dev deps are pruned after.
cloud_build() {
    local base
    base="$(cloud_base_path)"

    ynh_script_progression "Building web interface..."
    pushd "$install_dir" >/dev/null
        VITE_APP_PATH="$base" ynh_hide_warnings npm ci --no-audit --no-fund 2>&1 \
            || VITE_APP_PATH="$base" npm install --no-audit --no-fund 2>&1
        VITE_APP_PATH="$base" npm run build 2>&1
        npm prune --omit=dev 2>&1
    popd >/dev/null

    ynh_script_progression "Building API server..."
    pushd "$install_dir/server" >/dev/null
        ynh_hide_warnings npm ci --no-audit --no-fund 2>&1 \
            || npm install --no-audit --no-fund 2>&1
        npm run build 2>&1
        npm prune --omit=dev 2>&1
    popd >/dev/null
}

# install_dir holds the .env with JWT + proxy secrets: readable only by the app user.
cloud_fix_permissions() {
    chown -R "$app:$app" "$install_dir"
    chmod -R o-rwx "$install_dir"
    chmod 600 "$install_dir/server/.env"

    chown -R "$app:$app" "$data_dir"
    chmod 750 "$data_dir"
}
