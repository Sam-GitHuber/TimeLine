from django.apps import AppConfig, apps


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        # Files are swept off storage by a post_delete receiver rather than by
        # each delete path remembering to gather them — see api/media_cleanup.py
        # for why (issue #222). Connected here, in ready(), because that's the
        # one point where every model is loaded and importable.
        from .media_cleanup import register_media_cleanup

        register_media_cleanup(apps)
