import express from "express";

const router = express.Router()

router.get('/users',(req, res)=>{
  const users = [
    'bob',
    'alice',
    'tom'
  ]
  res.json({version: 'v2',users})
})


export default router