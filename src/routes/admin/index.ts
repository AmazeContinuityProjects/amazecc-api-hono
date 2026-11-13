/**
 * /api/admin/* - admin-only surface. Everything here requires an Amaze ID
 * session token (auth.amazecc.com) whose user has role `admin` in the shared
 * amazecc-auth D1 database, re-checked on every request.
 */
import { Hono } from "hono";

import { pushRoute } from "./push";
import * as buses from "./buses";
import * as cabshareHubs from "./cabshare-hubs";
import * as cabshareTrips from "./cabshare-trips";
import * as clubs from "./clubs";
import * as clubsRepresentatives from "./clubs-representatives";
import * as facultyDirectories from "./faculty-directories";
import * as fresherResources from "./fresher-resources";
import * as fresherResourcesId from "./fresher-resources-id";
import * as goroboAnalytics from "./gorobo-analytics";
import * as goroboBundles from "./gorobo-bundles";
import * as goroboBundlesId from "./gorobo-bundles-id";
import * as goroboItems from "./gorobo-items";
import * as goroboItemsId from "./gorobo-items-id";
import * as goroboItemsStock from "./gorobo-items-stock";
import * as goroboOrders from "./gorobo-orders";
import * as goroboOrdersId from "./gorobo-orders-id";
import * as goroboOrdersArchive from "./gorobo-orders-archive";
import * as goroboOrdersComplete from "./gorobo-orders-complete";
import * as goroboOrdersConfirm from "./gorobo-orders-confirm";
import * as goroboOrdersUnarchive from "./gorobo-orders-unarchive";
import * as goroboWallet from "./gorobo-wallet";
import * as goroboWalletSettle from "./gorobo-wallet-settle";
import * as migrate from "./migrate";
import * as ocr from "./ocr";
import * as ocrReset from "./ocr-reset";
import * as settingsGlobal from "./settings-global";
import * as stats from "./stats";
import * as storage from "./storage";
import * as transportPlacements from "./transport-placements";
import * as transportRoutes from "./transport-routes";
import * as transportRoutesId from "./transport-routes-id";
import * as transportRoutesIdStops from "./transport-routes-id-stops";
import * as transportRules from "./transport-rules";
import * as transportRulesId from "./transport-rules-id";
import * as transportSeed from "./transport-seed";
import * as transportStudents from "./transport-students";
import * as users from "./users";
import * as usersUsername from "./users-username";

export const adminRouter = new Hono();

/** Fabricate the Next-style context object the dynamic handlers expect. */
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

/* ── auth & push (Hono sub-routers) ─────────────────────────────────────── */
adminRouter.route("/", pushRoute);

/* ── simple admin CRUD ──────────────────────────────────────────────────── */
adminRouter.post("/buses", (c) => buses.POST(c.req.raw));

adminRouter.post("/cabshare/hubs", (c) => cabshareHubs.POST(c.req.raw));
adminRouter.delete("/cabshare/hubs", (c) => cabshareHubs.DELETE(c.req.raw));
adminRouter.get("/cabshare/trips", (c) => cabshareTrips.GET(c.req.raw));
adminRouter.delete("/cabshare/trips", (c) => cabshareTrips.DELETE(c.req.raw));

adminRouter.get("/clubs", (c) => clubs.GET(c.req.raw));
adminRouter.post("/clubs", (c) => clubs.POST(c.req.raw));
adminRouter.get("/clubs/representatives", (c) => clubsRepresentatives.GET(c.req.raw));
adminRouter.post("/clubs/representatives", (c) => clubsRepresentatives.POST(c.req.raw));
adminRouter.delete("/clubs/representatives", (c) => clubsRepresentatives.DELETE(c.req.raw));

adminRouter.get("/faculty-directories", (c) => facultyDirectories.GET(c.req.raw));
adminRouter.post("/faculty-directories", (c) => facultyDirectories.POST(c.req.raw));
adminRouter.put("/faculty-directories", (c) => facultyDirectories.PUT(c.req.raw));
adminRouter.delete("/faculty-directories", (c) => facultyDirectories.DELETE(c.req.raw));

adminRouter.get("/fresher-resources", (c) => fresherResources.GET(c.req.raw));
adminRouter.post("/fresher-resources", (c) => fresherResources.POST(c.req.raw));
adminRouter.patch("/fresher-resources/:id", (c) =>
  fresherResourcesId.PATCH(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.delete("/fresher-resources/:id", (c) =>
  fresherResourcesId.DELETE(c.req.raw, ctx({ id: c.req.param("id") }))
);

/* ── GoRoBo back-office ─────────────────────────────────────────────────── */
adminRouter.get("/gorobo/analytics", (c) => goroboAnalytics.GET(c.req.raw));

adminRouter.get("/gorobo/bundles", (c) => goroboBundles.GET(c.req.raw));
adminRouter.post("/gorobo/bundles", (c) => goroboBundles.POST(c.req.raw));
adminRouter.put("/gorobo/bundles/:id", (c) =>
  goroboBundlesId.PUT(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.delete("/gorobo/bundles/:id", (c) =>
  goroboBundlesId.DELETE(c.req.raw, ctx({ id: c.req.param("id") }))
);

adminRouter.get("/gorobo/items", (c) => goroboItems.GET(c.req.raw));
adminRouter.post("/gorobo/items", (c) => goroboItems.POST(c.req.raw));
adminRouter.put("/gorobo/items/:id", (c) =>
  goroboItemsId.PUT(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.delete("/gorobo/items/:id", (c) =>
  goroboItemsId.DELETE(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.patch("/gorobo/items/stock", (c) => goroboItemsStock.PATCH(c.req.raw));

adminRouter.get("/gorobo/orders", (c) => goroboOrders.GET(c.req.raw));
adminRouter.post("/gorobo/orders", (c) => goroboOrders.POST(c.req.raw));
adminRouter.get("/gorobo/orders/:id", (c) =>
  goroboOrdersId.GET(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.put("/gorobo/orders/:id", (c) =>
  goroboOrdersId.PUT(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.patch("/gorobo/orders/:id", (c) =>
  goroboOrdersId.PATCH(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.post("/gorobo/orders/:id/archive", (c) =>
  goroboOrdersArchive.POST(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.post("/gorobo/orders/:id/complete", (c) =>
  goroboOrdersComplete.POST(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.post("/gorobo/orders/:id/confirm", (c) =>
  goroboOrdersConfirm.POST(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.post("/gorobo/orders/:id/unarchive", (c) =>
  goroboOrdersUnarchive.POST(c.req.raw, ctx({ id: c.req.param("id") }))
);

adminRouter.get("/gorobo/wallet", (c) => goroboWallet.GET(c.req.raw));
adminRouter.post("/gorobo/wallet/orders/:id/settle", (c) =>
  goroboWalletSettle.POST(c.req.raw, ctx({ id: c.req.param("id") }))
);

/* ── migrate / ocr / misc ───────────────────────────────────────────────── */
adminRouter.post("/migrate", (c) => migrate.POST(c.req.raw));
adminRouter.get("/migrate", (c) => migrate.GET(c.req.raw));

adminRouter.post("/ocr", (c) => ocr.POST(c.req.raw));
adminRouter.post("/ocr/reset", (c) => ocrReset.POST(c.req.raw));

adminRouter.put("/settings/global", (c) => settingsGlobal.PUT(c.req.raw));
adminRouter.get("/stats", (c) => stats.GET(c.req.raw));
adminRouter.get("/storage", (c) => storage.GET(c.req.raw));
adminRouter.post("/storage", (c) => storage.POST(c.req.raw));

/* ── transport ──────────────────────────────────────────────────────────── */
adminRouter.get("/transport/placements", (c) => transportPlacements.GET(c.req.raw));
adminRouter.post("/transport/placements", (c) => transportPlacements.POST(c.req.raw));
adminRouter.get("/transport/routes", (c) => transportRoutes.GET(c.req.raw));
adminRouter.post("/transport/routes", (c) => transportRoutes.POST(c.req.raw));
adminRouter.get("/transport/routes/:id", (c) =>
  transportRoutesId.GET(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.put("/transport/routes/:id", (c) =>
  transportRoutesId.PUT(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.delete("/transport/routes/:id", (c) =>
  transportRoutesId.DELETE(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.post("/transport/routes/:id/stops", (c) =>
  transportRoutesIdStops.POST(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.get("/transport/rules", (c) => transportRules.GET(c.req.raw));
adminRouter.post("/transport/rules", (c) => transportRules.POST(c.req.raw));
adminRouter.delete("/transport/rules/:id", (c) =>
  transportRulesId.DELETE(c.req.raw, ctx({ id: c.req.param("id") }))
);
adminRouter.post("/transport/seed", (c) => transportSeed.POST(c.req.raw));
adminRouter.post("/transport/students", (c) => transportStudents.POST(c.req.raw));
adminRouter.delete("/transport/students", (c) => transportStudents.DELETE(c.req.raw));

/* ── users ──────────────────────────────────────────────────────────────── */
adminRouter.get("/users", (c) => users.GET(c.req.raw));
adminRouter.post("/users", (c) => users.POST(c.req.raw));
adminRouter.patch("/users/:username", (c) =>
  usersUsername.PATCH(c.req.raw, ctx({ username: c.req.param("username") }))
);
adminRouter.delete("/users/:username", (c) =>
  usersUsername.DELETE(c.req.raw, ctx({ username: c.req.param("username") }))
);
