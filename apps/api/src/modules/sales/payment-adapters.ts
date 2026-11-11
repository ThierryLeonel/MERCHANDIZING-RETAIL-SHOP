import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config";

export type ProviderStatus = "PENDING" | "CONFIRMED" | "FAILED";

/** Adapter contract for mobile money providers (MTN MoMo, Orange Money, ...). */
export interface MobileMoneyAdapter {
  readonly provider: string;
  readonly isSimulator: boolean;
  initiate(input: { requestReference: string; amount: string; currency: string; payerPhone?: string | null }): Promise<{ externalReference: string }>;
  verifySignature(rawBody: string, signature: string | undefined): boolean;
}

/**
 * DEVELOPMENT SIMULATOR — moves no money. A pending attempt is approved or
 * declined from the POS "simulate" controls, which emit a signed webhook
 * through the same verification and de-duplication path a live provider uses.
 */
@Injectable()
export class SimulatorMobileMoneyAdapter implements MobileMoneyAdapter {
  readonly provider = "SIMULATOR";
  readonly isSimulator = true;
  async initiate(input: { requestReference: string }) {
    return { externalReference: `SIM-${input.requestReference.slice(0, 12)}` };
  }
  sign(rawBody: string) {
    return createHmac("sha256", config.webhookSecret).update(rawBody).digest("hex");
  }
  verifySignature(rawBody: string, signature: string | undefined) {
    if (!signature) return false;
    const expected = Buffer.from(this.sign(rawBody));
    const got = Buffer.from(signature);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}

@Injectable()
export class PaymentAdapterRegistry {
  constructor(private simulator: SimulatorMobileMoneyAdapter) {}
  get(provider: string): MobileMoneyAdapter {
    if (provider === "SIMULATOR" && config.mobileMoneyMode === "simulator") return this.simulator;
    throw new Error(`Payment provider ${provider} is not configured (live adapters are Phase 4)`);
  }
  defaultProvider() {
    return config.mobileMoneyMode === "simulator" ? "SIMULATOR" : null;
  }
}
