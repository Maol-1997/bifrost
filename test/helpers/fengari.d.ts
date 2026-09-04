// Test-only surface of the Lua C API used to execute production Redis scripts.
declare module 'fengari' {
  export type LuaState = object;
  export function to_luastring(value: string): Uint8Array;
  export const lua: {
    LUA_OK: number;
    LUA_TBOOLEAN: number;
    LUA_TSTRING: number;
    LUA_TNUMBER: number;
    LUA_TTABLE: number;
    lua_newtable(state: LuaState): void;
    lua_pushliteral(state: LuaState, value: string): void;
    lua_pushboolean(state: LuaState, value: boolean): void;
    lua_pushinteger(state: LuaState, value: number): void;
    lua_pushjsfunction(state: LuaState, callback: (state: LuaState) => number): void;
    lua_rawseti(state: LuaState, index: number, key: number): void;
    lua_rawgeti(state: LuaState, index: number, key: number): number;
    lua_setfield(state: LuaState, index: number, key: Uint8Array): void;
    lua_setglobal(state: LuaState, key: Uint8Array): void;
    lua_tojsstring(state: LuaState, index: number): string;
    lua_toboolean(state: LuaState, index: number): boolean;
    lua_tonumber(state: LuaState, index: number): number;
    lua_type(state: LuaState, index: number): number;
    lua_rawlen(state: LuaState, index: number): number;
    lua_pop(state: LuaState, count: number): void;
    lua_close(state: LuaState): void;
  };
  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_dostring(state: LuaState, script: Uint8Array): number;
  };
}
