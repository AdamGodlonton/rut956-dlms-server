export interface RouterConfig {
  meter: string;
}

export const allowedRouters = new Map<string, RouterConfig>([
  ["868711065392659", { meter: "hexing-test-meter-001" }],
]);