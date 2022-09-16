import '../styles/main.scss';
import { SendRPC } from './lib/useRPC';
import { read, write } from './lib/RPC';
import { Fragment, useEffect, useMemo, useState } from 'react';
import ERC20 from '../abis/ERC20';
import Comet from '../abis/Comet';
import { CTokenSym, Network, NetworkConfig, getNetwork, getNetworkById, getNetworkConfig, isNetwork, showNetwork } from './Network';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract, ContractInterface } from '@ethersproject/contracts';
import { Close } from './Icons/Close';

const MAX_UINT256 = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935');

interface AppProps {
  sendRPC?: SendRPC
  web3: JsonRpcProvider
}

type AppPropsExt<N extends Network> = AppProps & {
  account: string,
  networkConfig: NetworkConfig<N>
};

interface AccountState<Network> {
  error: string | null;
  migratorEnabled: boolean;
  borrowBalanceV2?: bigint;
  usdcDecimals?: bigint;
  repayAmount: string;
  cTokens: Map<CTokenSym<Network>, CTokenState>;
}

interface CTokenState {
  address?: string,
  balance?: bigint,
  allowance?: bigint,
  exchangeRate?: bigint,
  transfer: string | 'max',
  decimals?: bigint,
  underlyingDecimals?: bigint,
}

interface Collateral {
  cToken: string,
  amount: bigint
}

function showAmount(amount: bigint | undefined, decimals: bigint | undefined): string {
  if (amount && decimals) {
    return (Number(amount) / Number(10n ** decimals)).toFixed(4);
  } else {
    return (0).toFixed(4);
  }
}

function amountToWei(amount: number, decimals: bigint): bigint {
  return BigInt(Math.floor(Number(amount) * Number(10n ** decimals)));
}

function usePoll(timeout: number) {
  const [timer, setTimer] = useState(0);

  useEffect(() => {
    let t: NodeJS.Timer;
    function loop(x: number, delay: number) {
      t = setTimeout(() => {
        requestAnimationFrame(() => {
          setTimer(x);
          loop(x + 1, delay);
        });
      }, delay);
    }
    loop(1, timeout);
    return () => clearTimeout(t)
  }, []);

  return timer;
}

function useAsyncEffect(fn: () => Promise<void>, deps: any[] = []) {
  useEffect(() => {
    (async () => {
      await fn();
    })();
  }, deps);
}

function parseNumber<T>(str: string, f: (x: number) => bigint): bigint | null {
  if (str === 'max') {
    return MAX_UINT256;
  } else {
    let num = Number(str);
    if (Number.isNaN(num)) {
      return null;
    } else {
      return f(num);
    }
  }
}

export function App<N extends Network>({sendRPC, web3, account, networkConfig}: AppPropsExt<N>) {
  let { cTokenNames } = networkConfig;

  let timer = usePoll(20000);

  const signer = useMemo(() => {
    return web3.getSigner().connectUnchecked();
  }, [web3, account]);

  const cTokensInitial = () => new Map(
    cTokenNames.map<[CTokenSym<Network>, CTokenState]>(
      (cTokenName) => [cTokenName, { transfer: "0" }]));

  const initialAccountState = () => ({
    error: null,
    migratorEnabled: false,
    repayAmount: "0",
    cTokens: cTokensInitial()
  });
  const [accountState, setAccountState] = useState<AccountState<Network>>(initialAccountState);

  const cTokenCtxs = useMemo(() => {
    return new Map(networkConfig.cTokenAbi.map(([cTokenName, address, abi]) =>
      [cTokenName, new Contract(address, abi ?? [], signer)]
    )) as Map<CTokenSym<Network>, Contract>}, [signer]);

  const migrator = useMemo(() => new Contract(networkConfig.migratorAddress, networkConfig.migratorAbi, signer), [signer]);
  const comet = useMemo(() => new Contract(networkConfig.rootsV3.comet, Comet, signer), [signer]);

  function setCTokenState<key extends keyof CTokenState, value extends CTokenState[key]>
    (tokenSym: CTokenSym<Network>, key: keyof CTokenState, value: CTokenState[key]) {
    setAccountState({
      ...accountState,
      error: null,
      cTokens: new Map(Array.from(accountState.cTokens.entries()).map<[CTokenSym<Network>, CTokenState]>(([sym, state]) => {
        if (sym === tokenSym) {
          return [sym, {
            ...state,
            [key]: value
          }];
        } else {
          return [sym, state];
        }
      }))
    });
  }

  async function setTokenApproval(tokenSym: CTokenSym<Network>) {
    console.log("setting allowance");
    await cTokenCtxs.get(tokenSym)!.approve(migrator.address, MAX_UINT256);
    console.log("setting allowance");
  }

  async function enableMigrator() {
    console.log("enabling migrator");
    await comet.allow(migrator.address, true);
    console.log("enabled migrator");
  }

  useAsyncEffect(async () => {
    let migratorEnabled = (await comet.allowance(account, migrator.address))?.toBigInt() > 0n;
    if (migratorEnabled) {
      let tokenStates = new Map(await Promise.all(Array.from(accountState.cTokens.entries()).map<Promise<[CTokenSym<Network>, CTokenState]>>(async ([sym, state]) => {
        let cTokenCtx = cTokenCtxs.get(sym)!;

        return [sym, {
          ...state,
          address: await cTokenCtx.address,
          balance: (await cTokenCtx.balanceOf(account)).toBigInt(),
          allowance: (await cTokenCtx.allowance(account, migrator.address)).toBigInt(),
          exchangeRate: (await cTokenCtx.callStatic.exchangeRateCurrent()).toBigInt(),
          decimals: state.decimals ?? BigInt(await cTokenCtx.decimals()),
          underlyingDecimals: state.underlyingDecimals ?? ( 'underlying' in cTokenCtx ? BigInt(await (new Contract(await cTokenCtx.underlying(), ERC20, web3)).decimals()) : 18n )
        }];
      })));

      let cUSDC = cTokenCtxs.get('cUSDC' as  CTokenSym<Network>);
      let usdcBorrowsV2 = await cUSDC?.callStatic.borrowBalanceCurrent(account);
      let usdcDecimals = cUSDC ? BigInt(await (new Contract(await cUSDC.underlying(), ERC20, web3)).decimals()) : 0n;

      setAccountState({
        ...accountState,
        migratorEnabled,
        borrowBalanceV2: usdcBorrowsV2.toString(),
        usdcDecimals: BigInt(usdcDecimals),
        cTokens: tokenStates
      });
    } else {
      setAccountState({
        ...accountState,
        migratorEnabled
      });
    }
  }, [timer, account, cTokenCtxs]);

  function validateForm(): { borrowAmount: bigint, collateral: Collateral[] } | string {
    let borrowAmount = accountState.borrowBalanceV2;
    let usdcDecimals = accountState.usdcDecimals;
    if (!borrowAmount || !usdcDecimals) {
      return "Invalid borrowAmount || usdcDecimals";
    }
    let repayAmount = parseNumber(accountState.repayAmount, (n) => amountToWei(n, usdcDecimals!));
    if (repayAmount === null) {
      return "Invalid repay amount";
    }
    if (repayAmount !== MAX_UINT256 && repayAmount > borrowAmount) {
      return "Too much repay";
    }

    let collateral: Collateral[] = [];
    for (let [sym, {address, balance, decimals, underlyingDecimals, transfer, exchangeRate}] of accountState.cTokens.entries()) {
      if (address !== undefined && decimals !== undefined && underlyingDecimals !== undefined && balance !== undefined && exchangeRate !== undefined) {
        if (transfer === 'max') {
          collateral.push({
            cToken: address,
            amount: balance
          });
        } else {
          let transferAmount = parseNumber(transfer, (n) => amountToWei(n * 1e18 / Number(exchangeRate), underlyingDecimals!));
          if (transferAmount === null) {
            return `Invalid collateral amount ${sym}: ${transfer}`;
          } else {
            if (transferAmount > 0n) {
              // TODO: Check too much
              collateral.push({
                cToken: address,
                amount: transferAmount
              });
            }
          }
        }
      }
    }
    return {
      borrowAmount: repayAmount,
      collateral
    };
  }

  let migrateParams = accountState.error ?? validateForm();

  async function migrate() {
    console.log("migrate", accountState, migrateParams);
    if (typeof migrateParams !== 'string') {
      try {
        await migrator.migrate(migrateParams.collateral, migrateParams.borrowAmount);
      } catch (e: any) {
        if ('code' in e && e.code === 'UNPREDICTABLE_GAS_LIMIT') {
          setAccountState({
            ...accountState,
            error: "Migration will fail if sent, e.g. due to collateral factors. Please adjust parameters."
          });
        }
      }
    }
  };

  let el;
  if (accountState.migratorEnabled) {
    el = (<Fragment>
      <div className="panel__header-row">
        <label className="L1 label text-color--2">Borrowing</label>
      </div>
      <div className="asset-row asset-row--active L3">
        <div className="asset-row__detail-content">
          <span className={`asset asset--${'USDC'}`} />
          <div className="asset-row__info">
            { accountState.repayAmount === 'max' ?
              <input className="action-input-view__input text-color--3" style={{fontSize: "2rem"}} disabled value="Max" /> :
              <input className="action-input-view__input" style={{fontSize: "2rem"}} type="text" inputMode="decimal" value={accountState.repayAmount} onChange={(e) => setAccountState({...accountState, repayAmount: e.target.value})} />
            }
          </div>
        </div>
        <div className="asset-row__balance">
          <p className="body text-color--3">
            {showAmount(accountState.borrowBalanceV2, accountState.usdcDecimals)}
          </p>
        </div>
        <div className="asset-row__actions">{ accountState.repayAmount === 'max' ?
            <button className="button button--selected" onClick={() => setAccountState({...accountState, repayAmount: '0'})}>
              <Close />
              <span>Max</span>
            </button>
          :
            <button className="button button--selected" onClick={() => setAccountState({...accountState, repayAmount: 'max'})}>
              <span>Max</span>
            </button>
          }
        </div>
      </div>
      <div className="panel__header-row">
        <label className="L1 label text-color--2">Supplying</label>
      </div>
      <div>
        { Array.from(accountState.cTokens.entries()).map(([sym, state]) => {
          return <div className="asset-row asset-row--active L3" key={`${sym}`}>
            <div className="asset-row asset-row--active L3">
              <div className="asset-row__detail-content">
                <span className={`asset asset--${sym.slice(1)}`} />
                <div className="asset-row__info">
                  { state.transfer === 'max' ?
                    <input className="action-input-view__input text-color--3" style={{fontSize: "2rem"}} disabled value="Max" /> :
                    <input className="action-input-view__input" style={{fontSize: "2rem"}} type="text" inputMode="decimal" value={state.transfer} onChange={(e) => setCTokenState(sym, 'transfer', e.target.value)} />
                  }
                </div>
              </div>
              <div className="asset-row__balance">
                <p className="body text-color--3">
                  {showAmount(state.exchangeRate ? (state.balance ?? 0n) * state.exchangeRate / 1000000000000000000n : 0n, state.underlyingDecimals)}
                </p>
              </div>
              <div className="asset-row__actions">{ state.allowance === 0n ?
                  <button className="button button--selected" onClick={() => setTokenApproval(sym)}>
                    <span>Enable</span>
                  </button>
                : (
                  state.transfer === 'max' ?
                    <button className="button button--selected" onClick={() => setCTokenState(sym, 'transfer', '0')}>
                      <Close />
                      <span>Max</span>
                    </button>
                  :
                    <button className="button button--selected" onClick={() => setCTokenState(sym, 'transfer', 'max')}>
                      <span>Max</span>
                    </button>
                  )
                }
              </div>
            </div>
          </div>
        })}
      </div>
    </Fragment>);
  } else {
    el = (<div>
      <button onClick={enableMigrator}>Enable Migrator</button>
    </div>);
  }

  return (
    <div className="page home">
      <div className="container">
        <div className="home__content">
          <div className="home__assets">
            <div className="panel panel--assets">
              <div className="panel__header-row">
                <label className="L1 label text-color--1">V2 Balances</label>
              </div>
              <div className="panel__header-row">
                <label className="label text-color--1">
                  Select the assets you want to migrate from Compound V2 to Compound V3.
                  If you are supplying USDC on one market while borrowing on another, any
                  supplied USDC will be used to repay borrowed USDC before entering you
                  into an earning position in Compound V3.
                </label>
              </div>
              { el }
              <div className="panel__header-row">
                <label className="L1 label text-color--2">Debug Information</label>
                <label className="label text-color--2">
                  timer={ timer }<br/>
                  network={ showNetwork(networkConfig.network) }<br/>
                  account={ account }<br/>
                </label>
              </div>
            </div>
          </div>
          <div className="home__sidebar">
            <div className="position-card__summary">
              <div className="panel position-card L3">
                <div className="panel__header-row">
                  <label className="L1 label text-color--1">Summary</label>
                </div>
                <div className="panel__header-row">
                  <p className="text-color--1">
                    If you are borrowing other assets on Compound V2,
                    migrating too much collateral could increase your
                    liquidation risk.
                  </p>
                </div>
                { typeof migrateParams === 'string' ?
                  <div className="panel__header-row">
                    <div className="action-input-view action-input-view--error L2">
                      <label className="action-input-view__title">
                        { migrateParams }
                      </label>
                    </div>
                  </div> : null
                }
                <div className="panel__header-row">
                  <button disabled={typeof migrateParams === 'string'} onClick={migrate}>Migrate Balances</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ({sendRPC, web3}: AppProps) => {
  let timer = usePoll(10000);
  const [account, setAccount] = useState<string | null>(null);
  const [networkConfig, setNetworkConfig] = useState<NetworkConfig<Network> | 'unsupported' | null>(null);

  useAsyncEffect(async () => {
    let accounts = await web3.listAccounts();
    if (accounts.length > 0) {
      let [account] = accounts;
      setAccount(account);
    }
  }, [web3, timer]);

  useAsyncEffect(async () => {
    let networkWeb3 = await web3.getNetwork();
    let network = getNetworkById(networkWeb3.chainId);
    if (network) {
      setNetworkConfig(getNetworkConfig(network));
    } else {
      setNetworkConfig('unsupported');
    }
  }, [web3, timer]);

  if (networkConfig && account) {
    if (networkConfig === 'unsupported') {
      return <div>Unsupported network...</div>;
    } else {
      return <App sendRPC={sendRPC} web3={web3} account={account} networkConfig={networkConfig} />;
    }
  } else {
    return <div>Loading...</div>;
  }
};
