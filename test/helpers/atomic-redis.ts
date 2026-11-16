import { lauxlib, lua, to_luastring, type LuaState } from 'fengari';
import type { ToolCacheRedisCommands } from '../../src/server/tools/cache-store.js';

/** Executes actual Lua; other clients' attempted writes queue until EVAL ends. */
export class AtomicRedisFake implements ToolCacheRedisCommands {
  readonly entries = new Map<string, string>();
  readonly reads: string[] = [];
  private afterGet: (() => void) | undefined;
  private readonly pendingWrites: (() => void)[] = [];

  writeAfterNextGet(operation: () => void): void {
    this.afterGet = () => {
      this.pendingWrites.push(operation);
    };
  }

  /** Bypasses serialization to test the cache's retained torn-snapshot guard. */
  corruptAfterNextGet(operation: () => void): void {
    this.afterGet = operation;
  }

  async eval(script: string, options: { keys: string[]; arguments?: string[] }): Promise<unknown> {
    const state = lauxlib.luaL_newstate();
    try {
      installStrings(state, { name: 'KEYS', values: options.keys });
      installStrings(state, { name: 'ARGV', values: options.arguments ?? [] });
      lua.lua_newtable(state);
      lua.lua_pushjsfunction(state, (current) => {
        const result = this.call(lua.lua_tojsstring(current, 1), lua.lua_tojsstring(current, 2));
        if (typeof result === 'string') lua.lua_pushliteral(current, result);
        else if (typeof result === 'number') lua.lua_pushinteger(current, result);
        else lua.lua_pushboolean(current, false);
        return 1;
      });
      lua.lua_setfield(state, -2, to_luastring('call'));
      lua.lua_setglobal(state, to_luastring('redis'));
      const status = lauxlib.luaL_dostring(state, to_luastring(script));
      if (status !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(state, -1));
      return redisReply(state);
    } finally {
      lua.lua_close(state);
      for (const write of this.pendingWrites.splice(0)) write();
    }
  }

  async set(key: string, value: string, options?: { NX?: true; PX?: number }): Promise<string | null> {
    if (options?.NX && this.entries.has(key)) return null;
    this.entries.set(key, value);
    return 'OK';
  }

  private call(command: string, key: string): string | number | undefined {
    switch (command) {
      case 'get': {
        this.reads.push(key);
        const value = this.entries.get(key);
        const afterGet = this.afterGet;
        this.afterGet = undefined;
        afterGet?.();
        return value;
      }
      case 'del':
        return this.entries.delete(key) ? 1 : 0;
      case 'incr': {
        const next = Number(this.entries.get(key) ?? 0) + 1;
        this.entries.set(key, String(next));
        return next;
      }
      // TTL/retention behavior is covered by the clocked in-memory store tests.
      case 'pexpire':
        return 1;
      default:
        throw new Error(`Unsupported fake Redis command: ${command}`);
    }
  }
}

function installStrings(state: LuaState, global: { name: string; values: readonly string[] }): void {
  lua.lua_newtable(state);
  for (const [index, value] of global.values.entries()) {
    lua.lua_pushliteral(state, value);
    lua.lua_rawseti(state, -2, index + 1);
  }
  lua.lua_setglobal(state, to_luastring(global.name));
}

function redisReply(state: LuaState): unknown {
  switch (lua.lua_type(state, -1)) {
    case lua.LUA_TSTRING:
      return lua.lua_tojsstring(state, -1);
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(state, -1);
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(state, -1) ? 1 : null;
    case lua.LUA_TTABLE: {
      const values: unknown[] = [];
      const length = lua.lua_rawlen(state, -1);
      for (let index = 1; index <= length; index += 1) {
        lua.lua_rawgeti(state, -1, index);
        values.push(redisReply(state));
        lua.lua_pop(state, 1);
      }
      return values;
    }
    default:
      throw new Error('Unsupported Lua result');
  }
}
