import os

# dmgbuild settings for the Relo DMG (read by `dmgbuild -s`), from the variables create_dmg.sh exports:
#  DMG_APP_PATH     the .app to put in the DMG
#  DMG_VOLUME_NAME  the name of the mounted volume
#  DMG_BACKGROUND   the window's background (.background/background.tiff, 1x and 2x)
#  DMG_ICON         the volume's icon (the app's own AppIcon.icns)

APP_PATH = os.environ.get('DMG_APP_PATH')
app_basename = os.path.basename(APP_PATH) if APP_PATH else 'Relo.app'

volume_name = os.environ.get('DMG_VOLUME_NAME', 'Relo')
format = 'UDZO'
compression_level = 9

files = [APP_PATH] if APP_PATH else []
symlinks = {'Applications': '/Applications'}

# The mounted volume and its Finder icon carry Relo's icon.
if os.environ.get('DMG_ICON') and os.path.exists(os.environ['DMG_ICON']):
    icon = os.environ['DMG_ICON']

# The window: Relo's aurora with a light curve from the app to Applications (drag it across).
background = os.environ.get('DMG_BACKGROUND', '')
window_rect = ((200, 120), (660, 400))
default_view = 'icon-view'
icon_size = 128
text_size = 13
icon_locations = {
    app_basename: (170, 190),
    'Applications': (490, 190),
}
show_statusbar = False
show_tabview = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
