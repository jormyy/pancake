export async function runWithCleanup(work,cleanup) {
  let failure
  try{return await work()}
  catch(error){failure=error;throw error}
  finally{
    try{await cleanup()}
    catch(error){
      if(failure)throw new AggregateError([failure,error],'Workload and cleanup both fail',{cause:failure})
      throw error
    }
  }
}
