// Doble de sesión solo para pruebas locales de la interfaz comercial.
module.exports=w=>{
 w.structuredClone=structuredClone;
 w.Experience={requestReason:async()=> 'Motivo de prueba local',onSection:()=>{}};
 w.Access={inventoryIntegrity:true,reversalReasons:true,userId:'test-user',can:()=>true,require:()=>{},sections:{},actions:{sale_create:'sales.create',sale_edit:'sales.edit',sale_cancel:'sales.cancel',receipt:'receipts.create',transfer:'movements.create',transfer_reverse:'movements.reverse',products_save:'inventory.write'},apply:()=>{},renderAdmin:async()=>{},seal:async s=>s,open:async s=>s,rpc:async(name,args)=>{const {data,error}=await w.supabase.rpc(name,args);if(error)throw Error(error.message);return data;}};
};
