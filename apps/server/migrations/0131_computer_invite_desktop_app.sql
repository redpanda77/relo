-- Add a computer: the invite asks for this system's desktop app (Relo for Mac, Relo for Windows), not only the Mac one.
ALTER TABLE computer_invites RENAME COLUMN setup_mac_app TO setup_desktop_app;
