import * as t from "io-ts";
import * as types from "./output";

export const GenericTypeAliasCodec = <T>(T: t.Type<T>): t.Type<types.GenericTypeAlias<T>> => t.recursion<types.GenericTypeAlias<T>>(`GenericTypeAlias<${T.name}>`, () => t.array(T));

export const NonGenericAliasCodec: t.Type<types.NonGenericAlias> = /* @__PURE__ */ t.recursion<types.NonGenericAlias>("NonGenericAlias", () => GenericTypeAliasCodec(t.string));

