import { TreasuryAccountDetail } from "@/components/treasury/treasury-details";
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <TreasuryAccountDetail id={id}/>;}
