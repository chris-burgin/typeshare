import * as t from "io-ts";
import * as types from "./output";

export const ItemIdCodec: t.Type<types.ItemId> = /* @__PURE__ */ t.recursion<types.ItemId>("ItemId", () => t.string);

