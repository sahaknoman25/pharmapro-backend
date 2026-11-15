// Action registry + dispatcher.
// Every action is POST /api/v1/actions/<name> with a JSON body that includes
// `token` (also accepted as a Bearer header). Response shape is always
// { ok: true, data } or { ok: false, error }.
import { AuthContext, requireAuth, requireRoles, requireSwmAdmin, resolveToken } from '../auth';
import { ApiError } from '../errors';
import { Handler, HandlerCtx, HandlerDef } from './types';
import * as authActions from './auth';
import * as posActions from './pos';
import * as inventoryActions from './inventory';
import * as purchaseActions from './purchases';
import * as customerActions from './customers';
import * as financeActions from './finance';
import * as reportActions from './reports';
import * as adminActions from './admin';

const REGISTRY: Record<string, HandlerDef> = {
  // Bootstrap & auth (no token needed, except updatemylanguage/logout)
  getbootstrap: { auth: false, handler: authActions.getbootstrap },
  login: { auth: false, handler: authActions.login },
  logout: { auth: false, handler: authActions.logout },
  setupworkspace: { auth: false, handler: authActions.setupworkspace },
  registerworkspace: { auth: false, handler: authActions.registerworkspace },
  updatemylanguage: { auth: true, handler: authActions.updatemylanguage },

  // Dashboard, reports, AI
  getdashboard: { auth: true, handler: reportActions.getdashboard },
  getreports: { auth: true, handler: reportActions.getreports },
  aiassistant: { auth: true, handler: reportActions.aiassistant },

  // POS & sales
  possearch: { auth: true, handler: posActions.possearch },
  createsale: { auth: true, handler: posActions.createsale },
  listsales: { auth: true, handler: posActions.listsales },
  voidsale: { auth: true, handler: posActions.voidsale },
  returnsale: { auth: true, handler: posActions.returnsale },

  // Medicines & batches
  listmedicines: { auth: true, handler: inventoryActions.listmedicines },
  savemedicine: { auth: true, handler: inventoryActions.savemedicine },
  listbatches: { auth: true, handler: inventoryActions.listbatches },
  adjuststock: { auth: true, handler: inventoryActions.adjuststock },
  setbatchstatus: { auth: true, handler: inventoryActions.setbatchstatus },
  listmovements: { auth: true, handler: inventoryActions.listmovements },
  createtransfer: { auth: true, handler: inventoryActions.createtransfer },
  listtransfers: { auth: true, handler: inventoryActions.listtransfers },

  // Purchases & suppliers
  listpurchases: { auth: true, handler: purchaseActions.listpurchases },
  createpurchase: { auth: true, handler: purchaseActions.createpurchase },
  listsuppliers: { auth: true, handler: purchaseActions.listsuppliers },
  savesupplier: { auth: true, handler: purchaseActions.savesupplier },
  supplierpayment: { auth: true, handler: purchaseActions.supplierpayment },

  // Customers & qarz
  listcustomers: { auth: true, handler: customerActions.listcustomers },
  savecustomer: { auth: true, handler: customerActions.savecustomer },
  customerpayment: { auth: true, handler: customerActions.customerpayment },
  customerstatement: { auth: true, handler: customerActions.customerstatement },

  // Finance
  listexpenses: { auth: true, handler: financeActions.listexpenses },
  saveexpense: { auth: true, handler: financeActions.saveexpense },
  closecash: { auth: true, handler: financeActions.closecash },
  listclosings: { auth: true, handler: financeActions.listclosings },

  // Employees, branches, settings
  listusers: { auth: true, handler: adminActions.listusers },
  saveuser: { auth: true, handler: adminActions.saveuser },
  listbranches: { auth: true, handler: adminActions.listbranches },
  savebranch: { auth: true, handler: adminActions.savebranch },
  updateworkspacesettings: { auth: true, handler: adminActions.updateworkspacesettings },

  // Subscription, backup, admin, audit
  getsubscription: { auth: true, handler: adminActions.getsubscription },
  changeplan: { auth: true, handler: adminActions.changeplan },
  exportdata: { auth: true, handler: adminActions.exportdata },
  restore: { auth: true, handler: adminActions.restore },
  listaudit: { auth: true, handler: adminActions.listaudit },
  swmoverview: { auth: true, handler: adminActions.swmoverview },
  swmsetworkspacestatus: { auth: true, handler: adminActions.swmsetworkspacestatus },
  registerpushtoken: { auth: true, handler: adminActions.registerpushtoken },
};

export const ACTION_NAMES = Object.keys(REGISTRY);

export async function dispatch(
  action: string,
  body: Record<string, unknown>,
  bearerToken?: string,
): Promise<unknown> {
  const def = REGISTRY[action];
  if (!def) throw new ApiError(`Unknown action: ${action}`, 404);
  const rawToken =
    (typeof body.token === 'string' ? body.token : undefined) ??
    (bearerToken?.startsWith('Bearer ') ? bearerToken.slice(7) : bearerToken);
  let auth: AuthContext | null = null;
  if (rawToken) auth = await resolveToken(rawToken);
  if (def.auth) {
    auth = requireAuth(auth);
    if (def.roles) requireRoles(auth, def.roles);
    if (def.swm) requireSwmAdmin(auth);
  }
  const ctx: HandlerCtx = { auth };
  const handler: Handler = def.handler;
  return handler(ctx, body);
}
