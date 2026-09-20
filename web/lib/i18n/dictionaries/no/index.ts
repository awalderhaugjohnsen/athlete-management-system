import type { Dictionary } from "../../types";
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

// Typed against `Dictionary` (inferred from the English dictionary) so a missing or
// differently-shaped key here is a compile error, not a silent gap in the Norwegian UI.
export const no: Dictionary = {
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
