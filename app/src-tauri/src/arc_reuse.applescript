on run argv
    set targetURL to item 1 of argv
    set fieldSeparator to ASCII character 9
    if application id "company.thebrowser.Browser" is not running then return "not_running"
    tell application id "company.thebrowser.Browser"
        with timeout of 5 seconds
            -- Hints are not authoritative: validate the live URL and privacy mode.
            if (count of argv) is 3 then
                try
                    set w to a reference to window id (item 2 of argv)
                    if incognito of w is false then
                        set t to a reference to tab id (item 3 of argv) of w
                        considering case
                            set matchesURL to ((URL of t) is targetURL)
                        end considering
                        if matchesURL then
                            select t
                            activate
                            return "reused" & fieldSeparator & (id of w) & fieldSeparator & (id of t) & fieldSeparator & "cache"
                        end if
                    end if
                end try
            end if
            -- Repeated opens often already point at the active tab.
            if (count of windows) > 0 then
                set w to a reference to front window
                if incognito of w is false then
                    try
                        set t to a reference to active tab of w
                        considering case
                            set matchesURL to ((URL of t) is targetURL)
                        end considering
                        if matchesURL then
                            activate
                            return "reused" & fieldSeparator & (id of w) & fieldSeparator & (id of t) & fieldSeparator & "active"
                        end if
                    end try
                end if
            end if
            repeat with w in windows
                -- Keep private windows separate from ordinary external links.
                if incognito of w is false then
                    repeat with s in spaces of w
                        set addresses to URL of every tab of s
                        repeat with tabIndex from 1 to count of addresses
                            considering case
                                set matchesURL to ((item tabIndex of addresses) is targetURL)
                            end considering
                            if matchesURL then
                                select (tab tabIndex of s)
                                activate
                                return "reused" & fieldSeparator & (id of w) & fieldSeparator & (id of tab tabIndex of s) & fieldSeparator & "scan"
                            end if
                        end repeat
                    end repeat
                end if
            end repeat
            repeat with w in windows
                if incognito of w is false then
                    tell active space of w to make new tab at end of tabs with properties {URL:targetURL}
                    -- Appended tabs become visible asynchronously. Probe the end
                    -- directly instead of fetching every URL on each retry.
                    repeat 4 times
                        try
                            set t to a reference to last tab of w
                            considering case
                                set matchesURL to ((URL of t) is targetURL)
                            end considering
                            if matchesURL then
                                select t
                                activate
                                return "opened" & fieldSeparator & (id of w) & fieldSeparator & (id of t) & fieldSeparator & "created"
                            end if
                        end try
                        delay 0.05
                    end repeat
                    set addresses to URL of every tab of w
                    repeat with tabIndex from 1 to count of addresses
                        considering case
                            set matchesURL to ((item tabIndex of addresses) is targetURL)
                        end considering
                        if matchesURL then
                            select (tab tabIndex of w)
                            activate
                            return "opened" & fieldSeparator & (id of w) & fieldSeparator & (id of tab tabIndex of w) & fieldSeparator & "created"
                        end if
                    end repeat
                    activate
                    return "opened"
                end if
            end repeat
        end timeout
    end tell
    return "not_found"
end run
