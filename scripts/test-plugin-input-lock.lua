package.path = "plugin/subminer/?.lua;" .. package.path

local input_lock_module = require("input_lock")

local function assert_true(condition, message)
	if condition then
		return
	end
	error(message)
end

local function assert_commands(recorded, expected, message)
	assert_true(#recorded == #expected, message .. ": expected " .. #expected .. " commands, got " .. #recorded)
	for index, command in ipairs(expected) do
		for part_index, part in ipairs(command) do
			assert_true(recorded[index][part_index] == part, message .. ": command " .. index .. " differs")
		end
	end
end

local LOCK = { "enable-section", "subminer-input-lock", "exclusive+allow-hide-cursor+allow-vo-dragging" }
local UNLOCK = { "disable-section", "subminer-input-lock" }

local function create_harness()
	local recorded = { commands = {}, timeouts = {}, osd = {}, logs = {} }
	local mp = {}
	function mp.commandv(...)
		recorded.commands[#recorded.commands + 1] = { ... }
	end
	function mp.add_timeout(seconds, callback)
		local timer = { seconds = seconds, callback = callback, killed = false }
		function timer:kill()
			self.killed = true
		end
		recorded.timeouts[#recorded.timeouts + 1] = timer
		return timer
	end
	local state = require("state").new()
	local ctx = {
		mp = mp,
		state = state,
		log = {
			subminer_log = function(level, _scope, message)
				recorded.logs[#recorded.logs + 1] = level .. ": " .. message
			end,
			show_osd = function(message)
				recorded.osd[#recorded.osd + 1] = message
			end,
		},
	}
	return input_lock_module.create(ctx), recorded, state
end

do
	local lock, recorded, state = create_harness()
	lock.handle_state_message("on")
	assert_true(state.input_lock_active == true, "on should mark the lock active")
	lock.keep_on_top()
	lock.handle_state_message("off")
	assert_true(state.input_lock_active == false, "off should clear the lock")
	lock.keep_on_top()
	assert_commands(recorded.commands, { LOCK, LOCK, UNLOCK }, "state messages and keep_on_top")
	print("plugin input lock state tests: OK")
end

do
	local lock, recorded = create_harness()
	lock.handle_state_message("on")
	lock.handle_blocked_key()
	lock.handle_blocked_key()
	assert_true(#recorded.timeouts == 1, "blocked keys should share one pending wait for the app")
	-- The app answers with its state.
	lock.handle_state_message("on")
	assert_true(recorded.timeouts[1].killed, "the app's answer should cancel the wait")
	assert_commands(recorded.commands, { LOCK, LOCK }, "answered blocked key")
	assert_true(#recorded.osd == 0, "an answered blocked key should not unlock")
	print("plugin input lock answered key tests: OK")
end

do
	local lock, recorded, state = create_harness()
	lock.handle_state_message("on")
	lock.handle_blocked_key()
	assert_true(recorded.timeouts[1].seconds > 0, "the wait for the app should have a timeout")
	recorded.timeouts[1].callback()
	assert_true(state.input_lock_active == false, "no answer should release the lock")
	assert_commands(recorded.commands, { LOCK, UNLOCK }, "unanswered blocked key")
	assert_true(#recorded.osd == 1, "releasing the lock should say so")
	assert_true(#recorded.logs == 1, "releasing the lock should be logged")
	-- A later blocked key waits again, and a late answer locks again.
	lock.handle_blocked_key()
	assert_true(#recorded.timeouts == 2, "a new blocked key should wait for the app again")
	lock.handle_state_message("on")
	assert_true(state.input_lock_active == true, "a late answer should lock again")
	print("plugin input lock crash recovery tests: OK")
end

do
	-- Loaded after the app locked mpv (plugin restart): the lock is unknown here, but a blocked
	-- key still gets released when the app does not answer.
	local lock, recorded = create_harness()
	lock.handle_blocked_key()
	recorded.timeouts[1].callback()
	assert_commands(recorded.commands, { UNLOCK }, "unknown lock without an answer")
	print("plugin input lock unknown state tests: OK")
end
