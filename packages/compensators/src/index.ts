/** Built-in compensator catalog (C1-C4). */

import type { ActionSignature, CompensationStep, EffectReceipt, Postcondition } from "@latticeag/vekrevert-core";
import { fsWrite, planForFs } from "./fs_write.ts";
import { httpCreate } from "./http_create.ts";
import { messageSend } from "./message_send.ts";
import { planForSql, sqlRow } from "./sql_row.ts";

export { fsWrite, planForFs } from "./fs_write.ts";
export { sqlRow, planForSql } from "./sql_row.ts";
export { httpCreate } from "./http_create.ts";
export { messageSend, slackPostMessage, discordCreateMessage, telegramSendMessage, emailManuals } from "./message_send.ts";

export const builtins: ActionSignature[] = [fsWrite, sqlRow, httpCreate, ...messageSend];

export function lowerSteps(
  signature: ActionSignature,
  receipt: EffectReceipt,
): { steps: CompensationStep[]; postconditions?: Postcondition[] } | undefined {
  if (signature.id === "cmp_fs_write@1") return planForFs(receipt);
  if (signature.id === "cmp_sql_row@1") return planForSql(receipt);
  return undefined;
}
