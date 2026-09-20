// The English dictionary is the source of truth for shape: `Dictionary` (see ../../types.ts) is
// inferred from this object, and dictionaries/no/index.ts is type-checked against it — so a
// namespace added to Norwegian without its English counterpart (or vice versa) fails `tsc`
// instead of silently falling back to English at runtime.
import { auth } from "./auth";
import { chat } from "./chat";
import { common } from "./common";
import { dashboard } from "./dashboard";
import { nutrition } from "./nutrition";
import { plan } from "./plan";
import { profile } from "./profile";
import { report } from "./report";
import { setup } from "./setup";
import { sidebar } from "./sidebar";

export const en = {
  common,
  sidebar,
  auth,
  profile,
  dashboard,
  plan,
  report,
  nutrition,
  setup,
  chat,
};
