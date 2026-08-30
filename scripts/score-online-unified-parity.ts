import { readFileSync } from "node:fs";

import { scoreOnlineUnifiedRawFeatures } from "@/features/crossdating/diagnosis/onlineUnifiedModel";

type Request = {
    head: "operation" | "location";
    features: Record<string, number>;
};

const requests = JSON.parse(readFileSync(0, "utf8")) as Request[];
process.stdout.write(JSON.stringify(requests.map((request) => (
    scoreOnlineUnifiedRawFeatures(request.head, request.features)
))));
