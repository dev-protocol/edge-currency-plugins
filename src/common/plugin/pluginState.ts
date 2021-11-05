// Typescript translation from original code in edge-currency-bitcoin

import { asArray, asEither, asNull, asObject, asString } from 'cleaners'
import { navigateDisklet } from 'disklet'
import { EdgeIo, EdgeLog } from 'edge-core-js/types'
import { makeMemlet } from 'memlet'

import { UtxoEngineState } from '../utxobased/engine/makeUtxoEngineState'
import { asServerInfoCache, ServerScores } from './serverScores'

const serverListInfoUrl = 'https://info1.edge.app/v1/blockBook/'
const asWebsocketUrl = (raw: unknown): string => {
  const url = new URL(asString(raw))
  return `wss://${url.host}/websocket`
}
const asServerListInfo = asObject(asEither(asArray(asWebsocketUrl), asNull))

/** A JSON object (as opposed to an array or primitive). */
interface JsonObject {
  [name: string]: unknown
}

export interface CurrencySettings {
  customFeeSettings: string[]
  blockBookServers: string[]
  disableFetchingServers?: boolean
}

/**
 * This object holds the plugin-wide per-currency caches.
 * Engine plugins are responsible for keeping it up to date.
 */
export interface PluginStateSettings {
  io: EdgeIo
  defaultSettings: CurrencySettings
  currencyCode: string
  pluginId: string
  log: EdgeLog
}

export interface PluginState {
  addEngine: (engineState: UtxoEngineState) => void
  removeEngine: (engineState: UtxoEngineState) => void
  dumpData: () => JsonObject
  load: () => Promise<PluginState>
  serverScoreDown: (uri: string) => void
  serverScoreUp: (uri: string, score: number) => void
  clearCache: () => Promise<void>
  getLocalServers: (
    numServersWanted: number,
    includePatterns: string[]
  ) => string[]
  updateServers: (settings: JsonObject) => Promise<void>
}

export function makePluginState(settings: PluginStateSettings): PluginState {
  const { io, defaultSettings, currencyCode, pluginId, log } = settings
  let defaultServers = defaultSettings.blockBookServers
  let disableFetchingServers = !!(
    defaultSettings.disableFetchingServers ?? false
  )
  let engines: UtxoEngineState[] = []
  const memlet = makeMemlet(navigateDisklet(io.disklet, 'plugins/' + pluginId))

  let serverCacheJson = {}
  let serverCacheDirty = false
  let servers = {}

  const serverScores = new ServerScores(log)

  const saveServerCache = async (): Promise<void> => {
    serverScores.printServers(servers)
    if (serverCacheDirty) {
      await memlet.setJson('serverCache.json', servers).catch(e => {
        log(`${pluginId} - ${JSON.stringify(e.toString())}`)
      })
      serverCacheDirty = false
      serverScores.scoresLastLoaded = Date.now()
      log(`${pluginId} - Saved server cache`)
    }
  }

  const dirtyServerCache = (serverUrl: string): void => {
    serverCacheDirty = true
    for (const engine of engines) {
      if (engine.processedPercent === 1) {
        for (const uri of engine.getServerList()) {
          if (uri === serverUrl) {
            saveServerCache().catch(e => {
              log(`${pluginId} - ${JSON.stringify(e.toString())}`)
            })
            return
          }
        }
      }
    }
  }

  const fetchServers = async (): Promise<string[] | null> => {
    log(`${pluginId} - GET ${serverListInfoUrl}`)

    const response = await io.fetch(serverListInfoUrl)
    const responseBody = await (async () => {
      try {
        if (response.ok) {
          return await response.json()
        }
        log(
          `${pluginId} - Fetching ${serverListInfoUrl} failed with status ${response.status}`
        )
      } catch (err) {
        log(`${pluginId} - Fetching ${serverListInfoUrl} failed: ${err}`)
      }
      return {}
    })()

    const serverListInfo = asServerListInfo(responseBody)

    return serverListInfo[currencyCode] ?? null
  }

  const refreshServers = async (): Promise<void> => {
    let serverList = defaultServers

    if (!disableFetchingServers)
      serverList = (await fetchServers()) ?? defaultServers

    serverScores.serverScoresLoad(
      servers,
      serverCacheJson,
      dirtyServerCache,
      serverList
    )
    await saveServerCache()

    // Tell the engines about the new servers:
    for (const engine of engines) {
      engine.refillServers()
    }
  }

  return {
    /**
     * Begins notifying the engine of state changes. Used at connection time.
     */
    addEngine(engineState: UtxoEngineState): void {
      engines.push(engineState)
    },

    /**
     * Stops notifying the engine of state changes. Used at disconnection time.
     */
    removeEngine(engineState: UtxoEngineState): void {
      engines = engines.filter(engine => engine !== engineState)
    },

    dumpData(): JsonObject {
      return {
        'pluginState.servers_': servers
      }
    },

    async load(): Promise<PluginState> {
      try {
        serverCacheJson = asServerInfoCache(
          await memlet.getJson('serverCache.json')
        )
      } catch (e) {
        log(`${pluginId}: Failed to load server cache: ${JSON.stringify(e)}`)
      }

      // Fetch servers in the background:
      refreshServers().catch(e => {
        log(`${pluginId} - ${JSON.stringify(e.toString())}`)
      })

      return this
    },

    serverScoreDown(uri: string): void {
      serverScores.serverScoreDown(servers, uri, dirtyServerCache)
    },

    serverScoreUp(uri: string, score: number): void {
      serverScores.serverScoreUp(servers, uri, score, dirtyServerCache)
    },

    async clearCache(): Promise<void> {
      serverScores.clearServerScoreTimes()
      servers = {}
      serverCacheDirty = true
      await saveServerCache()
      await refreshServers()
    },

    getLocalServers(
      numServersWanted: number,
      includePatterns: string[] = []
    ): string[] {
      return serverScores.getServers(servers, numServersWanted, includePatterns)
    },

    async updateServers(settings: JsonObject): Promise<void> {
      const { blockBookServers } = settings
      if (typeof settings.disableFetchingServers === 'boolean') {
        disableFetchingServers = settings.disableFetchingServers
      }
      if (Array.isArray(blockBookServers)) {
        defaultServers = blockBookServers
      }
      const enginesToBeStopped = []
      const disconnects = []
      for (const engine of engines) {
        enginesToBeStopped.push(engine)
        engine.setServerList([])
        disconnects.push(engine.stop())
      }
      await Promise.all(disconnects)
      serverScores.clearServerScoreTimes()
      serverCacheJson = {}
      serverCacheDirty = true
      await saveServerCache()
      await refreshServers()
      for (const engine of enginesToBeStopped) {
        await engine.stop()
      }
    }
  }
}
