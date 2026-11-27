from __future__ import annotations

from fastapi import APIRouter, Request, Response
from sqlalchemy import select

from ..app_settings import get_app_settings
from ..audit import audit
from ..config import get_settings
from ..deps import DB, CurrentUser
from ..errors import ApiError
from ..metrics import LOGINS
from ..models import User
from ..schemas import ErrorOut, LoginIn, UserOut, UserPatch
from ..security import COOKIE_NAME, create_session_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def user_out(u: User) -> UserOut:
    return UserOut(id=str(u.id), username=u.username, locale=u.locale)


@router.post("/login", response_model=UserOut, responses={401: {"model": ErrorOut}})
def login(body: LoginIn, request: Request, response: Response, db: DB) -> UserOut:
    user = db.scalar(select(User).where(User.username == body.username))
    if user is None or not verify_password(body.password, user.password_hash):
        LOGINS.labels(result="failed").inc()
        audit(db, body.username[:150], "login_failed", request=request)
        raise ApiError(401, "invalid_credentials", "Неверный логин или пароль")
    ttl = get_app_settings(db).session_ttl_hours
    response.set_cookie(
        COOKIE_NAME, create_session_token(user.id, user.username, ttl), max_age=ttl * 3600,
        httponly=True, secure=get_settings().cookie_secure, samesite="lax", path="/",
    )
    LOGINS.labels(result="ok").inc()
    audit(db, user.username, "login", request=request)
    return user_out(user)


@router.post("/logout", status_code=204)
def logout(request: Request, db: DB) -> Response:
    resp = Response(status_code=204)
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> UserOut:
    return user_out(user)


@router.patch("/me", response_model=UserOut, responses={400: {"model": ErrorOut}})
def update_me(body: UserPatch, request: Request, user: CurrentUser, db: DB) -> UserOut:
    if body.locale is not None:
        user.locale = body.locale
    if body.password is not None:
        if not verify_password(body.password.current, user.password_hash):
            raise ApiError(400, "invalid_password", "Текущий пароль указан неверно")
        user.password_hash = hash_password(body.password.new)
        audit(db, user.username, "password_changed", request=request, commit=False)
    db.commit()
    return user_out(user)
