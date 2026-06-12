 [HttpPost]
 [Route(APIEndpoint.DefaultRoute + "/GetAllBorrowers")]
 public async Task<IActionResult> GetAllBorrowers()
 {
     try
     {
         APIResponse result = await this.Manager.GetAllBorrowersRawAsync(null);
         return Ok(result);
     }
     catch (Exception ex)
     {
         return StatusCode(500, new APIResponse(ResponseCode.ERROR, $"Error: {ex.Message}", null));
     }
 }