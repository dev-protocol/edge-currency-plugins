import { Mutex } from 'async-mutex'
import {
  createOrOpenCountBase,
  createOrOpenHashBase,
  createOrOpenRangeBase
} from 'baselet'
import { Disklet } from 'disklet'

import {
  AddressByScriptPubkeyBaselet,
  addressByScriptPubkeyOptions,
  LastUsedByFormatPathBaselet,
  lastUsedByFormatPathOptions,
  ScriptPubkeyByPathBaselet,
  scriptPubkeyByPathOptions,
  TxByIdBaselet,
  txByIdOptions,
  TxIdByBlockHeightBaselet,
  TxIdByDateBaselet,
  txIdsByBlockHeightOptions,
  txIdsByDateOptions,
  UtxoByIdBaselet,
  utxoByIdOptions,
  UtxoIdsByScriptPubkeyBaselet,
  utxoIdsByScriptPubkeyOptions
} from './Models/baselet'

interface MakeBaseletsConfig {
  disklet: Disklet
}

type Executor<BaseletName extends keyof AllBaselets, T> = (
  tables: AllBaselets[BaseletName]
) => Promise<T>

interface AllBaselets {
  address: AddressBaselets
  tx: TransactionBaselets
  utxo: UtxoBaselets
}

interface AddressBaselets {
  addressByScriptPubkey: AddressByScriptPubkeyBaselet
  scriptPubkeyByPath: ScriptPubkeyByPathBaselet
  lastUsedByFormatPath: LastUsedByFormatPathBaselet
}

interface TransactionBaselets {
  txById: TxByIdBaselet
  txIdsByBlockHeight: TxIdByBlockHeightBaselet
  txIdsByDate: TxIdByDateBaselet
}

interface UtxoBaselets {
  utxoById: UtxoByIdBaselet
  utxoIdsByScriptPubkey: UtxoIdsByScriptPubkeyBaselet
}

export interface Baselets {
  address: <T>(fn: Executor<'address', T>) => Promise<T>
  tx: <T>(fn: Executor<'tx', T>) => Promise<T>
  utxo: <T>(fn: Executor<'utxo', T>) => Promise<T>
  all: AddressBaselets & TransactionBaselets & UtxoBaselets
}

export const makeBaselets = async (
  config: MakeBaseletsConfig
): Promise<Baselets> => {
  /* Tables */
  const addressBases: AddressBaselets = {
    addressByScriptPubkey: await createOrOpenHashBase(
      config.disklet,
      addressByScriptPubkeyOptions
    ),
    scriptPubkeyByPath: await createOrOpenCountBase(
      config.disklet,
      scriptPubkeyByPathOptions
    ),
    lastUsedByFormatPath: await createOrOpenHashBase(
      config.disklet,
      lastUsedByFormatPathOptions
    )
  }
  const txBases: TransactionBaselets = {
    txById: await createOrOpenHashBase(config.disklet, txByIdOptions),
    txIdsByBlockHeight: await createOrOpenRangeBase(
      config.disklet,
      txIdsByBlockHeightOptions
    ),
    txIdsByDate: await createOrOpenRangeBase(config.disklet, txIdsByDateOptions)
  }
  const utxoBases: UtxoBaselets = {
    utxoById: await createOrOpenHashBase(config.disklet, utxoByIdOptions),
    utxoIdsByScriptPubkey: await createOrOpenHashBase(
      config.disklet,
      utxoIdsByScriptPubkeyOptions
    )
  }

  const addressMutex = new Mutex()
  const txMutex = new Mutex()
  const utxoMutex = new Mutex()

  return {
    async address(fn) {
      return await addressMutex.runExclusive(async () => await fn(addressBases))
    },

    async tx(fn) {
      return await txMutex.runExclusive(async () => await fn(txBases))
    },

    async utxo(fn) {
      return await utxoMutex.runExclusive(async () => await fn(utxoBases))
    },

    all: {
      ...addressBases,
      ...txBases,
      ...utxoBases
    }
  }
}
