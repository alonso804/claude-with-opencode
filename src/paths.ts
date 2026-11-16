import { homedir } from "node:os"
import { join } from "node:path"

export const APP = "claude-with-opencode"

// OpenCode resolves its directories with xdg-basedir on every platform,
// Windows included, so these mirror its layout rather than %APPDATA%.
const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const xdgCache = () => process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
const xdgData = () =>
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")

export const appConfigDir = () => join(xdgConfig(), APP)
export const appCacheDir = () => join(xdgCache(), APP)

export const opencodeConfigDir = () => join(xdgConfig(), "opencode")
export const opencodeDataDir = () => join(xdgData(), "opencode")
export const opencodeCacheDir = () => join(xdgCache(), "opencode")
