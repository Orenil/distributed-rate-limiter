-- Atomic hierarchical sliding-window-counter check-and-increment.
--
-- Evaluates every hierarchy level (e.g. key, tenant, global) in a single Redis
-- round trip, inside Redis's single-threaded script execution. This is what makes
-- the whole hierarchy atomic: two concurrent gateway instances calling EVALSHA at
-- "the same time" are still fully serialized by Redis, so there is no window in
-- which both read "9 of 10 used" and both admit request #10, and a request that is
-- denied at, say, the tenant level never partially increments the key-level counter.
--
-- KEYS[1..N]   hash key per hierarchy level, caller-ordered (e.g. key, tenant, global)
-- ARGV[1]      now, epoch milliseconds (passed by the client, not read via TIME, so
--              the script stays deterministic and trivially testable)
-- ARGV[2]      ttl seconds applied to every touched hash
-- ARGV[3+2*i]  limit for KEYS[i+1]     (i = 0..N-1)
-- ARGV[4+2*i]  windowMs for KEYS[i+1]
--
-- Returns {allowed (1/0), deniedLevelIndex (1-based, 0 if allowed)}

local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local n = #KEYS

local newStart = {}
local newCurr = {}
local newPrev = {}

for i = 1, n do
  local limit = tonumber(ARGV[1 + 2 * i])
  local window = tonumber(ARGV[2 + 2 * i])

  local data = redis.call('HMGET', KEYS[i], 'windowStart', 'currCount', 'prevCount')
  local storedStart = tonumber(data[1])
  local storedCurr = tonumber(data[2]) or 0
  local storedPrev = tonumber(data[3]) or 0

  local curWindowStart = math.floor(now / window) * window

  local currCount = 0
  local prevCount = 0

  if storedStart ~= nil then
    if storedStart == curWindowStart then
      currCount = storedCurr
      prevCount = storedPrev
    elseif storedStart == curWindowStart - window then
      -- exactly one window elapsed: last "current" becomes "previous"
      currCount = 0
      prevCount = storedCurr
    end
    -- else: more than one window elapsed, both stay at zero (stale)
  end

  local elapsed = (now - curWindowStart) / window
  if elapsed < 0 then elapsed = 0 end
  local estimate = currCount + prevCount * (1 - elapsed)

  if estimate + 1 > limit then
    return { 0, i }
  end

  newStart[i] = curWindowStart
  newCurr[i] = currCount + 1
  newPrev[i] = prevCount
end

-- Every level passed: commit all increments together so a mid-hierarchy denial
-- never leaks a partial increment into an earlier level's counter.
for i = 1, n do
  redis.call('HMSET', KEYS[i], 'windowStart', newStart[i], 'currCount', newCurr[i], 'prevCount', newPrev[i])
  redis.call('EXPIRE', KEYS[i], ttl)
end

return { 1, 0 }
