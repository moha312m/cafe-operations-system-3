import {test} from "node:test";
import assert from "node:assert/strict";
import {currentWorkspaceHref} from "../src/lib/workspace-navigation";
test("table setup selects one specific leaf while the table workspace remains an ancestor",()=>{
 assert.equal(currentWorkspaceHref("/tables/setup",["/tables","/tables/setup","/pos"]),"/tables/setup");
 assert.equal(currentWorkspaceHref("/tables/setup/detail",["/tables/setup","/tables"]),"/tables/setup");
 assert.equal(currentWorkspaceHref("/tables-other",["/tables"]),undefined);
});

test('query leaves choose POS register and returns without losing ordinary sales',()=>{
 const links=['/sales','/sales?source=CASHIER_POS','/sales?returns=1'];
 assert.equal(currentWorkspaceHref('/sales?source=CASHIER_POS&page=2',links),links[1]);
 assert.equal(currentWorkspaceHref('/sales?returns=1',links),links[2]);
 assert.equal(currentWorkspaceHref('/sales?invoice=one',links),links[0]);
});
