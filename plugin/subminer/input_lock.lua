local M = {}

-- The app locks mpv's own key bindings while its card review dialog is open by enabling an
-- exclusive input section (src/core/services/mpv-input-lock.ts). The names must match it.
local SECTION = "subminer-input-lock"
local SECTION_FLAGS = "exclusive+allow-hide-cursor+allow-vo-dragging"
-- How long a blocked key waits for the app to answer before the lock is released.
local APP_ANSWER_TIMEOUT_SECONDS = 3

function M.create(ctx)
	local mp = ctx.mp
	local state = ctx.state
	local subminer_log = ctx.log.subminer_log
	local show_osd = ctx.log.show_osd

	local function clear_answer_timeout()
		if state.input_lock_answer_timeout then
			state.input_lock_answer_timeout:kill()
			state.input_lock_answer_timeout = nil
		end
	end

	local function set_active(active)
		state.input_lock_active = active
		if active then
			mp.commandv("enable-section", SECTION, SECTION_FLAGS)
		else
			mp.commandv("disable-section", SECTION)
		end
	end

	-- `on` or `off` from the app. Enabling or disabling here too keeps the final state right
	-- whatever order the app's own section commands and this plugin's binding changes ran in.
	local function handle_state_message(value)
		clear_answer_timeout()
		if value == "on" then
			set_active(true)
		elseif value == "off" then
			set_active(false)
		end
	end

	-- mpv moves a section to the top whenever it is enabled, and changing this plugin's key
	-- bindings re-enables its sections, which would lift them above the lock.
	local function keep_on_top()
		if state.input_lock_active then
			mp.commandv("enable-section", SECTION, SECTION_FLAGS)
		end
	end

	-- The lock swallowed a key. The app answers with its lock state; no answer means it quit or
	-- crashed with the dialog open, so give mpv its keys back instead of leaving it stuck.
	local function handle_blocked_key()
		if state.input_lock_answer_timeout then
			return
		end
		state.input_lock_answer_timeout = mp.add_timeout(APP_ANSWER_TIMEOUT_SECONDS, function()
			state.input_lock_answer_timeout = nil
			set_active(false)
			subminer_log("warn", "input-lock", "SubMiner did not answer; released the mpv input lock")
			show_osd("Not responding. mpv controls are unlocked.")
		end)
	end

	return {
		handle_state_message = handle_state_message,
		handle_blocked_key = handle_blocked_key,
		keep_on_top = keep_on_top,
	}
end

return M
