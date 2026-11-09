import * as t from "io-ts";
import * as types from "./output";

export const ItemIdCodec: t.Type<types.ItemId> = /* @__PURE__ */ t.recursion<types.ItemId>("ItemId", () => t.string);

export const OptionsCodec: t.Type<types.Options> = /* @__PURE__ */ t.recursion<types.Options>("Options", () => t.string);

