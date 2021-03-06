/* eslint-disable react-hooks/exhaustive-deps */
import 'gun/lib/radix';
import 'gun/lib/radisk';
import 'gun/lib/store';
import 'gun/lib/rindexed';
import LZString from 'lz-string';
import { IGunCryptoKeyPair } from 'gun/types/types';
import Gun from 'gun';
import {redirect} from 'remix'
// import { getUserSession, master } from '~/session.server';

export const encrypt = async (
  data: any,
  keys: AuthKeys | IGunCryptoKeyPair,
  sign: boolean = false
) => {
  console.log('Encrypting data with new keys...');

  let enc = await Gun.SEA.encrypt(data, JSON.stringify(keys));
  var _data = await Gun.SEA.sign(enc, keys);
  if (sign === true) {
    return _data;
  }
  return LZString.compress(_data)
};

export const decrypt = async (
  data: any,
  keys: AuthKeys | IGunCryptoKeyPair,
  verify: boolean = false
) => {
  console.log('Encrypting data with new keys...');

  let enc = LZString.decompress(data)
  var msg = await Gun.SEA.verify(enc, keys.pub);
  if (verify === true) {
    return msg
  }
  return await Gun.SEA.decrypt(msg, JSON.stringify(keys));

};



export type Credentials = {
  alias?: string;
  idString: string;
  colorCode: Array<string>;
  keys?: AuthKeys
}

export type AuthKeys = {
  pub: string;
  priv: string;
};

export interface EnvironmentVariables {
  PUB: string
  PRIV: string
  EPUB: string
  EPRIV: string
  GUN_PORT: number | string
  CLIENT_PORT: number | string
  DOMAIN: string
}


function GunCtx(env: EnvironmentVariables) {
  
  const ports = {
    DOMAIN: env.DOMAIN,
    RELAY: env.GUN_PORT,
    CLIENT: env.CLIENT_PORT
  };
  const master: IGunCryptoKeyPair = {
    pub: env.PUB,
    priv: env.PRIV,
    epub: env.EPUB,
    epriv: env.EPRIV
  }
  if (!ports || !master) throw new Error('Run "yarn generate" or "npm run generate" to generate your keypair then set it in your environment variables');
  const gun = new Gun({
    file: `${ports.DOMAIN}.private_relay`,
    peers: [`http://0.0.0.0:${ports.RELAY}gun`, `http://${ports.DOMAIN}:${ports.RELAY}gun` || `htts://${ports.DOMAIN}:${ports.RELAY}gun`],
    localStorage: false,
    radisk: true
  });
  
  let { getSession, commitSession, destroySession } = createCookieSessionStorage({
    cookie: {
      name: 'FM_session',
      secure: true,
      secrets: [master.epriv],
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: true,
    },
  });
  
  async function createUserSession(result: {epub: string, epriv: string}, colorCode: string, redirectTo: string) {
    let session = await getSession();
    let store = {
      enc: result,
      v: colorCode
    }
    let res = await Gun.SEA.encrypt(store.enc, master)
    //session storage encryptionKey
    session.set('encrypt', res);
    //color code session
    session.set('color', colorCode)
  
    return redirect(redirectTo, {
      headers: { 'Set-Cookie': await commitSession(session) },
    });
  }


  const createUser = async (
    { alias, idString }: Credentials
  ): Promise<{ ok: boolean, result: string, keys?: { auth: AuthKeys, enc: AuthKeys, phrase: string } }> =>
    new Promise(async (resolve) => {
      /** Generate Keypair */
      const pair = await Gun.SEA.pair();

      const exists = await getVal(`@${pair.pub}`, 'creds')
      if (exists) {
        resolve({ ok: false, result: 'Alias already exists' })
      }
      const a: AuthKeys = {
        pub: pair.pub,
        priv: pair.priv
      }
      const e: AuthKeys = {
        pub: pair.epub,
        priv: pair.epriv
      }


      /** Encrypt && Sign */
      const comp = await encrypt({ a: alias, i: idString, e: e }, a)

      console.info(`\n \n **** COMPRESSED USER DATA ****  ??? size:  ${comp.length} ??? \n \n${comp}\n \n`)
      /** Store user data */
      let store = await putVal(`@${alias}`, 'creds', comp)
      if (!store) resolve({ ok: false, result: 'Could not store credentials' })
      /** else */
      resolve({ ok: true, result: comp, keys: { auth: a, enc: e, phrase: idString } })

    }

    );

  const validate = (
    pair: AuthKeys
  ): Promise<{ ok: boolean, result: any }> =>
    new Promise(async (resolve) => {
      let stored = await getVal(`@${pair.pub}`, 'creds')
      if (!stored) resolve({ ok: false, result: 'Alias Not Found' })
      console.log(`\n \n **** stored data **** \n \n  ${stored}`)

      let dec = await decrypt(stored, pair)
      console.log(`\n \n **** decrypted **** \n \n  ${dec}`)

      let proof = await Gun.SEA.work(dec, pair)
      console.log(`\n \n **** Hashing decrypted data and keypair **** \n \n  ${proof}`)

      if (!proof) {
        console.error('Keys invalid')
        resolve({ ok: false, result: 'Keys invalid' })
      }
      resolve({ ok: true, result: dec })

    });


  const putVal = async (document: string, key: string, value: any, encryptionKey?: AuthKeys | IGunCryptoKeyPair): Promise<string | undefined> => {
    if (encryptionKey) {
      value = await encrypt(value, encryptionKey);
    }
    value = await encrypt(value, master)
    return new Promise((resolve) =>
      gun.get(document).get(key).put(value as never, (ack) => {
        console.log(ack)
        resolve(ack.ok ? 'Added data!' : ack.err?.message ?? undefined);
      })
    )
  }

  const getVal = (document: string, key: string, decryptionKey?: AuthKeys | IGunCryptoKeyPair) => {
    return new Promise((resolve) =>
      gun.get(document).get(key).once(async (data) => {
        console.log('data:', data)
        decryptionKey
          ? resolve(await decrypt(data, decryptionKey))
          : resolve(await decrypt(data, master))
      })
    )
  }
  return {
    authenticate: async (request: Request): Promise<{ ok: boolean, result: any, keys?: any }> => {
      let { alias, idString, pub, priv, colorCode } = Object.fromEntries(
        await request.formData()
      );
      // let session = await getUserSession(request)
      let fields: any
      let err: { [key: string]: string }
      return new Promise(async (resolve) => {
        if (typeof idString !== 'string' || idString.length < 20) {
          err.string = `Identification string must be at least 15 characters long. Try 'oH pen seSAme SEEDS'. Note: UTF-16 characters accepted `
        }
        idString = fields.idString
        if (typeof colorCode !== 'string' || colorCode.length < 6) {
          err.colorCode = `Color code combo must be of at least 6 `
        }
        colorCode = fields.colorCode
        /** set colorcode in session storage and remove it from fields object */
        // session.set('color', colorCode)
        delete fields.colorCode
        if (typeof alias === 'string') {
          /** createUser if making new profile */
          alias = fields.alias;
          const { ok, result, keys } = await createUser(fields);
          if (!ok) {
            resolve({ ok: false, result });
          }
          if (err) resolve({ ok: false, result: err })
          resolve({ ok: true, result, keys, });

        }
        if (typeof pub !== 'string' && priv !== 'string') {
          err.keys = 'Was unable to find keys stored in your browser. Please paste in your keys and try again.'
        }
        let keypair = {
          pub: fields.keys.pub,
          priv: fields.keys.priv
        }
        /** validate */

        const { ok, result } = await validate(keypair)
        if (!ok) {
          err.auth = result
        }

        console.log(`\n \n result \n \n `)
        console.log(result)
        resolve({ ok: true, result })
      }
      )
    },

    isAuthenticated: async (request: Request) => {

    }

  }
}

export const createContext:CtxType = (request: Request, env: EnvironmentVariables): {
  auth: Promise<{
    ok: boolean;
    result: any;
    keys?: any;
  }>
} => {
  const { authenticate } = GunCtx(env)
  return {
    auth: authenticate(request)
  }
}

export type CtxType = {
  (request: Request, env: EnvironmentVariables): {
    auth: Promise<{
      ok: boolean;
      result: any;
      keys?: any;
    }>
  }
}

function createCookieSessionStorage(arg0: { cookie: { name: string; secure: boolean; secrets: any[]; sameSite: string; path: string; maxAge: number; httpOnly: boolean; }; }): { getSession: any; commitSession: any; destroySession: any; } {
  throw new Error('Function not implemented.');
}


function master(store: { enc: any; v: string; }, master: any) {
  throw new Error('Function not implemented.');
}
